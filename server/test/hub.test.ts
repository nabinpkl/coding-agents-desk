/* The hub client: the service token it presents, and which of the hub's answers
 * is the reader's problem and which is ours. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHubClient, HubBusy, HubRefused, HubUnreachable } from "../src/hub.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function edge(responder: (call: Call) => { status?: number; body?: unknown } = () => ({ body: [] })): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status = 200, body = null } = responder(call);
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const CONFIG = { url: "https://relay.example", accessClientId: "id", accessClientSecret: "secret" };

test("every call carries the service token as headers, the way Access takes it", async () => {
  // Not a minted assertion: the edge does the exchange, so there is nothing to mint. Getting this
  // wrong passes against a fake and fails against Cloudflare with a 404 on the token endpoint.
  const { fetch, calls } = edge();
  const hub = createHubClient(CONFIG, fetch);
  await hub.directory();
  await hub.directory();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.headers["cf-access-client-id"], "id");
    assert.equal(call.headers["cf-access-client-secret"], "secret");
  }
  assert.equal(calls[0]?.headers["cf-access-jwt-assertion"], undefined, "no assertion is minted locally");
});

test("a redirect to a sign-in page is a refused credential, not a JSON body to parse", async () => {
  // Access answers an unusable service token with a 30x and an HTML login page.
  const impl = (async () => new Response("<html>Sign in</html>", { status: 302, headers: { location: "https://relay.example/cdn-cgi/access/login" } })) as unknown as typeof fetch;
  const hub = createHubClient(CONFIG, impl);
  await assert.rejects(
    () => hub.directory(),
    (e: unknown) => e instanceof HubUnreachable && /sign-in page/.test(e.message) && /service token/.test(e.message),
  );
});

test("sends as the owner, with the body and refs the caller gave, and reports the id it was given", async () => {
  const { fetch, calls } = edge((call) => (call.url.endsWith("/v1/messages") ? { status: 201, body: { id: "m1", state: "queued" } } : { body: [] }));
  const hub = createHubClient(CONFIG, fetch);
  const out = await hub.send({ to: "opencode:ses_1", body: "look at this", refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "7" }] });
  assert.equal(out.id, "m1");
  const post = calls.find((c) => c.url.endsWith("/v1/messages"))!;
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, { as: "human", to: "opencode:ses_1", kind: "request", body: "look at this", refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "7" }] });
});

test("the hub's refusals come back as the reader's problem, in the hub's own words", async () => {
  // 400/404/409/422 are answers to what was asked: a stale pick, a full thread, a hop limit. 429 is
  // deliberately not here: being over budget is not the same kind of no, and it is its own error.
  for (const status of [400, 404, 409, 422]) {
    const { fetch } = edge(() => ({ status, body: { error: `hub says ${status}` } }));
    const hub = createHubClient(CONFIG, fetch);
    await assert.rejects(() => hub.send({ to: "opencode:ses_1", body: "hi", refs: [] }), (e: unknown) => e instanceof HubRefused && e.message === `hub says ${status}`);
  }
});

test("being over the hub's budget is 'not now', not 'not that', and carries the hub's own wait", async () => {
  // An extension that reads a budget refusal as a bad address either gives up or retries harder.
  // It has to be able to tell the two apart, and it has to learn how long to wait.
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/cdn-cgi/access/token")) return Response.json({ token: "jwt-1", expires_in: 3600 });
    return new Response(JSON.stringify({ error: "annotator is over its writes budget: POST /v1/messages. Retry in 4s." }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "4" },
    });
  }) as unknown as typeof fetch;
  const hub = createHubClient(CONFIG, impl);
  await assert.rejects(
    () => hub.send({ to: "opencode:ses_1", body: "hi", refs: [] }),
    (e: unknown) => {
      assert.ok(e instanceof HubBusy, "a budget refusal is not a refusal and not an outage");
      assert.equal((e as HubBusy).retryAfterSeconds, 4, "the wait is the hub's, not one invented here");
      return true;
    },
  );
});

test("a rejected credential is ours, and the message names it without printing the secret", async () => {
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

test("a hub that is down is unreachable, and so is a 500", async () => {
  const { fetch } = edge(() => ({ status: 500, body: { error: "boom" } }));
  await assert.rejects(() => createHubClient(CONFIG, fetch).directory(), (e: unknown) => e instanceof HubUnreachable);

  const offline = createHubClient(CONFIG, (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch);
  await assert.rejects(() => offline.directory(), (e: unknown) => e instanceof HubUnreachable && /could not reach the hub/.test(e.message));
});

test("a directory entry with no address or name is dropped rather than shown as a blank recipient", async () => {
  const { fetch } = edge(() => ({ body: [{ address: "opencode:a", name: "A", machine: null, cwd: null, reachability: "reachable", lastSeenAt: null, related: [] }, { name: "no address" }, null, 7] }));
  assert.deepEqual((await createHubClient(CONFIG, fetch).directory()).map((r) => r.address), ["opencode:a"]);
});

test("an unfamiliar reachability reads as offline, so nothing is offered as answerable when it is not", async () => {
  const { fetch } = edge(() => ({ body: [{ address: "opencode:a", name: "A", reachability: "starting" }] }));
  assert.equal((await createHubClient(CONFIG, fetch).directory())[0]?.reachability, "offline");
});

test("an accepted message with no id is a failure, not a send that will never be found", async () => {
  const { fetch } = edge(() => ({ status: 201, body: { state: "queued" } }));
  await assert.rejects(() => createHubClient(CONFIG, fetch).send({ to: "opencode:a", body: "hi", refs: [] }), (e: unknown) => e instanceof HubUnreachable && /no id/.test(e.message));
});
