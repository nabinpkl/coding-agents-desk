// The budgets as a caller meets them, over HTTP with a real Access assertion: a 429 that says how
// long to wait, one caller's loop not spending another's, and a stream cap that a machine with one
// stream per live session does not trip.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createVerifier } from "@/auth";
import { parsePrincipals, type HubConfig } from "@/config";
import { Directives } from "@/directives";
import { Messages } from "@/messages";
import { RateLimiter, type Limits } from "@/ratelimit";
import { createFetch } from "@/routes";
import { HubStore } from "@/store";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-test";

// Small on purpose: these tests are about the refusal, not about waiting a minute for a refill.
const LIMITS: Limits = { writes: { capacity: 3, refillPerSecond: 1 }, reads: { capacity: 2, refillPerSecond: 1 }, maxStreams: 2 };

let key: CryptoKey;
let jwks: ReturnType<typeof Bun.serve>;
let hub: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const config: HubConfig = {
    host: "127.0.0.1",
    port: 0,
    dbFile: ":memory:",
    access: { teamDomain: TEAM, audience: AUD, jwksUrl: `http://127.0.0.1:${jwks.port}/certs` },
    principals: parsePrincipals("mac.access=mac:mac:human,oracle.access=oracle:oracle,annotator.access=annotator::human"),
    ownerEmail: null,
  };
  const messages = new Messages(new HubStore(":memory:"));
  const directives = new Directives(messages);
  hub = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch: createFetch({ messages, directives, verify: createVerifier(config), log: () => {}, limiter: new RateLimiter(LIMITS, () => 0) }),
  });
});

afterAll(() => {
  hub.stop(true);
  jwks.stop(true);
});

async function assertion(clientId: string): Promise<string> {
  // `common_name` is where the verifier reads the service token's client id from.
  return new SignJWT({ common_name: clientId })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

async function call(path: string, opts: { as?: string; method?: string; body?: unknown } = {}): Promise<Response> {
  const headers = new Headers({ "cf-access-jwt-assertion": await assertion(opts.as ?? "mac.access") });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${hub.port}${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

const publish = { bots: [{ botId: "bot-1", name: "One", path: "/w", sessionIds: ["opencode:s1"] }] };

describe("request budgets", () => {
  test("a publish loop is refused, and the refusal says how long to wait", async () => {
    const statuses: number[] = [];
    let refused: Response | null = null;
    for (let i = 0; i < 5; i += 1) {
      const res = await call("/v1/directory/bots/mac", { method: "PUT", body: publish });
      statuses.push(res.status);
      if (res.status === 429) refused ??= res;
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const body = (await refused!.json()) as { error: string };
    expect(body.error).toContain("writes budget");
    // Retry-After is the difference between backing off and hammering harder.
    expect(refused!.headers.get("retry-after")).toBe("1");
  });

  test("one caller's refused loop leaves another caller alone", async () => {
    // The mac token is already out of budget from the test above.
    expect((await call("/v1/directory/bots/mac", { method: "PUT", body: publish })).status).toBe(429);
    // A different machine has its own budget, and a shared one would let a busy machine silence it.
    expect((await call("/v1/directory/bots/oracle", { as: "oracle.access", method: "PUT", body: publish })).status).toBe(200);
  });

  test("reads and writes are separate, so polling hard cannot stop a machine reporting", async () => {
    // Spend the oracle machine's read budget on polling. `as` is a session, since threads are per
    // session; a Bot address names a destination, not a reader.
    const as = "opencode:ses_ratelimit";
    expect((await call(`/v1/threads?as=${as}`, { as: "oracle.access" })).status).toBe(200);
    expect((await call(`/v1/threads?as=${as}`, { as: "oracle.access" })).status).toBe(200);
    expect((await call(`/v1/threads?as=${as}`, { as: "oracle.access" })).status).toBe(429);
    // And its publish still goes through, which one shared balance would have stopped.
    expect((await call("/v1/directory/bots/oracle", { as: "oracle.access", method: "PUT", body: publish })).status).toBe(200);
  });

  test("a stream cap refuses the third stream and frees the slot when one ends", async () => {
    // Streams are long-lived, so the test opens two, expects the third refused, and cancels one.
    const controllers: AbortController[] = [];
    const connect = async (session: string): Promise<Response> => {
      const ac = new AbortController();
      controllers.push(ac);
      const headers = { "cf-access-jwt-assertion": await assertion("mac.access") };
      return fetch(`http://127.0.0.1:${hub.port}/v1/stream?session=${session}&source=opencode`, { headers, signal: ac.signal });
    };
    const first = await connect("aaa");
    const second = await connect("bbb");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await connect("ccc")).status).toBe(429);
    // A machine's stream ending gives the slot back, so a session closing does not leak capacity.
    controllers[0]!.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect((await connect("ddd")).status).toBe(200);
    for (const ac of controllers) ac.abort();
  });

  test("health is not charged to anybody's budget", async () => {
    for (let i = 0; i < 5; i += 1) expect((await call("/health", { as: "stranger.access" })).status).toBe(200);
  });
});
