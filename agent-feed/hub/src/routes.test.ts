import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { createVerifier } from "@/auth";
import { parsePrincipals, type HubConfig } from "@/config";
import { Messages } from "@/messages";
import { createFetch } from "@/routes";
import { HubStore } from "@/store";

const TEAM = "team.example.com";
const AUD = "hub-aud";
const SESSION = "44444444-4444-4444-4444-444444444444";

let key: CryptoKey;
let jwks: ReturnType<typeof Bun.serve>;
let hub: ReturnType<typeof Bun.serve>;

async function token(commonName: string, overrides: { aud?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT({ common_name: commonName })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(overrides.iss ?? `https://${TEAM}`)
    .setAudience(overrides.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

async function call(path: string, init: RequestInit & { as?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.as) headers.set("cf-access-jwt-assertion", await token(init.as));
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${hub.port}${path}`, { ...init, headers });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const config: HubConfig = {
    host: "127.0.0.1",
    port: 0,
    dbFile: ":memory:",
    access: { teamDomain: TEAM, audience: AUD, jwksUrl: `http://127.0.0.1:${jwks.port}/certs` },
    principals: parsePrincipals("mac.access=mac:mac:human,annotator.access=annotator::human"),
  };
  const messages = new Messages(new HubStore(":memory:"));
  hub = Bun.serve({ port: 0, idleTimeout: 60, fetch: createFetch({ messages, verify: createVerifier(config), log: () => {} }) });
});

afterAll(() => {
  hub.stop(true);
  jwks.stop(true);
});

describe("auth", () => {
  test("health is open, everything else needs a known service token", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/v1/directory")).status).toBe(401);
    expect((await call("/v1/directory", { as: "stranger.access" })).status).toBe(401);
    const wrongAud = await fetch(`http://127.0.0.1:${hub.port}/v1/directory`, { headers: { "cf-access-jwt-assertion": await token("mac.access", { aud: "other" }) } });
    expect(wrongAud.status).toBe(401);
    expect((await call("/v1/directory", { as: "mac.access" })).status).toBe(200);
  });

  test("a surface-only token cannot open a session stream", async () => {
    expect((await call(`/v1/stream?session=${SESSION}&channel=1`, { as: "annotator.access" })).status).toBe(403);
  });
});

describe("stream", () => {
  test("a message sent to a streaming session arrives on its stream and is confirmed", async () => {
    const stream = await call(`/v1/stream?session=${SESSION}&channel=1&cwd=/work/x&title=probe`, { as: "mac.access" });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6)) as Record<string, unknown>;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
      }
    };
    const hello = await next();
    expect(hello).toMatchObject({ type: "hello", address: `claude:${SESSION}`, channel: true });

    const sent = await call("/v1/messages", { as: "annotator.access", method: "POST", body: JSON.stringify({ as: "human", to: `claude:${SESSION}`, kind: "request", body: "fix it", refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "14" }] }) });
    expect(sent.status).toBe(201);
    const pushed = await next();
    expect(pushed).toMatchObject({ type: "message", fromName: "owner" });
    const message = pushed.message as { id: string };
    const confirmed = await call(`/v1/messages/${message.id}/delivered`, { as: "mac.access", method: "POST", body: JSON.stringify({ stream: hello.streamId }) });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { state: string }).state).toBe("delivered");

    const reply = await call("/v1/messages", { as: "mac.access", method: "POST", body: JSON.stringify({ as: `claude:${SESSION}`, inReplyTo: message.id, body: "done" }) });
    expect(reply.status).toBe(201);
    const threads = (await (await call("/v1/threads?as=human", { as: "annotator.access" })).json()) as unknown[][];
    expect(threads[0]).toHaveLength(2);
    await reader.cancel();
  });

  test("bad input is a 400, not a 500", async () => {
    expect((await call("/v1/messages", { as: "mac.access", method: "POST", body: "{nope" })).status).toBe(400);
    expect((await call("/v1/messages", { as: "mac.access", method: "POST", body: JSON.stringify({ as: "human", to: "nobody", kind: "request", body: "x" }) })).status).toBe(400);
  });
});
