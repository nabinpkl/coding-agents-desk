/* The hub client: the Access token exchange, that the token is reused, and which
 * of the hub's answers is the reader's problem and which is ours. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHubClient, HubRefused, HubUnreachable } from "../src/hub.ts";

interface Call {
  url: string;
  method: string;
  assertion: string | null;
  clientId: string | null;
  body: unknown;
}

function edge(responder: (call: Call) => { status?: number; body: unknown }, opts: { token?: { status: number; body: unknown } } = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      assertion: headers.get("cf-access-jwt-assertion"),
      clientId: headers.get("cf-access-client-id"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (url.endsWith("/cdn-cgi/access/token")) {
      if (opts.token) return Response.json(opts.token.body, { status: opts.token.status });
      if (call.clientId !== "id") return Response.json({ error: "bad service token" }, { status: 400 });
      return Response.json({ token: `jwt-${calls.filter((c) => c.url.includes("token")).length}`, expires_in: 3600 });
    }
    const { status = 200, body } = responder(call);
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const CONFIG = { url: "https://relay.example", accessClientId: "id", accessClientSecret: "secret", accessTokenUrl: "https://team.example/cdn-cgi/access/token" };

test("a call presents a minted Access assertion, and the token is reused rather than reminted", async () => {
  const { fetch, calls } = edge(() => ({ body: [] }));
  const hub = createHubClient(CONFIG, fetch);
  await hub.directory();
  await hub.directory();
  const tokens = calls.filter((c) => c.url.includes("/token"));
  assert.equal(tokens.length, 1, "one exchange should serve both calls");
  const hubCalls = calls.filter((c) => !c.url.includes("/token"));
  assert.deepEqual(hubCalls.map((c) => c.assertion), ["jwt-1", "jwt-1"]);
});

test("a stale token is reminted once the old one is nearly expired", async () => {
  let minted = 0;
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      minted += 1;
      // 30s of life against a 60s margin: already inside it, so the next call must remint.
      return Response.json({ token: `jwt-${minted}`, expires_in: 30 });
    }
    return Response.json([], { status: 200 });
  }) as unknown as typeof fetch;
  const hub = createHubClient(CONFIG, impl);
  await hub.directory();
  await hub.directory();
  assert.equal(minted, 2, "a token inside the refresh margin should not be handed out");
});

test("sends as human, with the body and refs the caller gave, and reports the id it was given", async () => {
  const { fetch, calls } = edge((call) => (call.url.endsWith("/v1/messages") ? { status: 201, body: { id: "m1", state: "queued" } } : { body: [] }));
  const hub = createHubClient(CONFIG, fetch);
  const out = await hub.send({ to: "opencode:ses_1", body: "look at this", refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "7" }] });
  assert.equal(out.id, "m1");
  const post = calls.find((c) => c.url.endsWith("/v1/messages"))!;
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, { as: "human", to: "opencode:ses_1", kind: "request", body: "look at this", refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "7" }] });
});

test("the hub's refusals come back as the reader's problem, in the hub's own words", async () => {
  // 400/404/409/429 are answers to what was asked: a stale pick, a full thread, a hop limit.
  for (const status of [400, 404, 409, 422, 429]) {
    const { fetch } = edge(() => ({ status, body: { error: `hub says ${status}` } }));
    const hub = createHubClient(CONFIG, fetch);
    await assert.rejects(() => hub.send({ to: "opencode:ses_1", body: "hi", refs: [] }), (e: unknown) => e instanceof HubRefused && e.message === `hub says ${status}`);
  }
});

test("a rejected credential is ours, and the message names the credential without printing it", async () => {
  for (const status of [401, 403]) {
    const { fetch } = edge(() => ({ status, body: { error: "nope" } }));
    const hub = createHubClient(CONFIG, fetch);
    await assert.rejects(
      () => hub.directory(),
      (e: unknown) => {
        assert.ok(e instanceof HubUnreachable, "an unusable token is not the reader's to fix");
        assert.match(e.message, /Access service token/);
        assert.ok(!e.message.includes("secret"), "the secret must never reach a message that is logged");
        return true;
      },
    );
  }
});

test("a hub that is down is unreachable, not a refusal, and a 500 is not the reader's to fix", async () => {
  const { fetch } = edge(() => ({ status: 500, body: { error: "boom" } }));
  const hub = createHubClient(CONFIG, fetch);
  await assert.rejects(() => hub.directory(), (e: unknown) => e instanceof HubUnreachable);

  // A network failure is reported against the hop that failed, which is the token endpoint first.
  const offline = createHubClient(CONFIG, (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch);
  await assert.rejects(() => offline.directory(), (e: unknown) => e instanceof HubUnreachable && /Access token endpoint/.test(e.message));

  // And with a token in hand, the same failure names the hub.
  const hubDown = createHubClient(CONFIG, (async (input: string | URL | Request) => {
    if (String(input).endsWith("/token")) return Response.json({ token: "jwt-1", expires_in: 3600 });
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch);
  await assert.rejects(() => hubDown.directory(), (e: unknown) => e instanceof HubUnreachable && /could not reach the hub/.test(e.message));
});

test("a token endpoint that will not mint is unreachable, and says so", async () => {
  const { fetch } = edge(() => ({ body: [] }), { token: { status: 400, body: { error: "bad service token" } } });
  const hub = createHubClient(CONFIG, fetch);
  await assert.rejects(() => hub.directory(), (e: unknown) => e instanceof HubUnreachable && /Access token endpoint/.test(e.message));
});

test("a directory entry with no address or name is dropped rather than shown as a blank recipient", async () => {
  const { fetch } = edge(() => ({ body: [{ address: "opencode:a", name: "A", machine: null, cwd: null, reachability: "reachable", lastSeenAt: null, related: [] }, { name: "no address" }, null, 7] }));
  const hub = createHubClient(CONFIG, fetch);
  assert.deepEqual((await hub.directory()).map((r) => r.address), ["opencode:a"]);
});

test("an unfamiliar reachability reads as offline, so nothing is offered as answerable when it is not", async () => {
  const { fetch } = edge(() => ({ body: [{ address: "opencode:a", name: "A", reachability: "starting" }] }));
  const hub = createHubClient(CONFIG, fetch);
  assert.equal((await hub.directory())[0]?.reachability, "offline");
});

test("an accepted message with no id is a failure, not a send that will never be found", async () => {
  const { fetch } = edge(() => ({ status: 201, body: { state: "queued" } }));
  const hub = createHubClient(CONFIG, fetch);
  await assert.rejects(() => hub.send({ to: "opencode:a", body: "hi", refs: [] }), (e: unknown) => e instanceof HubUnreachable && /no id/.test(e.message));
});
