// The MCP endpoint through a real SDK client: auth at the HTTP layer, the four tools against a
// live store, and the sender guard coming from the hub rather than the caller.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { createVerifier } from "@/auth";
import { parsePrincipals, type HubConfig } from "@/config";
import { Directives } from "@/directives";
import { Messages } from "@/messages";
import { createFetch } from "@/routes";
import { HubStore } from "@/store";

const TEAM = "team.example.com";
const AUD = "hub-aud";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let key: CryptoKey;
let jwks: ReturnType<typeof Bun.serve>;
let hub: ReturnType<typeof Bun.serve>;

async function token(commonName: string): Promise<string> {
  return new SignJWT({ common_name: commonName })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

/** A Managed OAuth user token carries an email, not a service-token client id. */
async function emailToken(email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

// Small helper because the SDK Client takes its transport at connect time, not construction.
async function connect(as?: string): Promise<Client> {
  const init: RequestInit = {};
  if (as) init.headers = { "cf-access-jwt-assertion": await token(as) };
  return connectWith(init);
}

async function connectWith(init: RequestInit): Promise<Client> {
  const c = new Client({ name: "mcp-test", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), { requestInit: init }));
  return c;
}

async function connectEmail(email: string): Promise<Client> {
  return connectWith({ headers: { "cf-access-jwt-assertion": await emailToken(email) } });
}

async function rpc(path: string, init: RequestInit & { as?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.as) headers.set("cf-access-jwt-assertion", await token(init.as));
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${hub.port}${path}`, { ...init, headers });
}

/** Opens a hub stream the way the sidecar does, and reads one message event off it. */
async function streamSession(session: string): Promise<{ streamId: string; next: () => Promise<Record<string, unknown>>; close: () => void }> {
  const response = await rpc(`/v1/stream?session=${session}&source=opencode&channel=1&cwd=/work&title=probe`, { as: "mac.access" });
  if (response.status !== 200) throw new Error(`stream refused: ${response.status}`);
  const reader = response.body!.getReader();
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
  const streamId = (hello as { streamId: string }).streamId;
  return { streamId, next, close: () => void reader.cancel() };
}

async function publish(bots: [string, string][]): Promise<void> {
  // One PUT carries the whole machine list: the hub replaces its copy whole on every publish.
  const response = await rpc("/v1/directory/bots/mac", {
    as: "mac.access",
    method: "PUT",
    body: JSON.stringify({ bots: bots.map(([botId, session]) => ({ botId, name: botId, path: "/work", sessionIds: [`opencode:${session}`] })) }),
  });
  if (response.status !== 200) throw new Error(`publish refused: ${response.status}`);
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
    ownerEmail: "owner@example.com",
  };
  const messages = new Messages(new HubStore(":memory:"));
  const directives = new Directives(messages);
  hub = Bun.serve({ port: 0, idleTimeout: 60, fetch: createFetch({ messages, directives, verify: createVerifier(config), log: () => {} }) });
});

afterAll(() => {
  hub.stop(true);
  jwks.stop(true);
});

describe("mcp auth", () => {
  test("no token is a 401 before any MCP framing", async () => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(response.status).toBe(401);
  });
});

describe("mcp owner login", () => {
  test("the owner speaks as a session without belonging to a machine", async () => {
    const a = await streamSession(A);
    try {
      await publish([["abot", A]]);
      const c = await connectEmail("owner@example.com");
      try {
        const sent = await c.callTool({ name: "hub_send", arguments: { to: "human", body: "owner note", kind: "report", session_id: A } });
        expect(sent.isError).toBeFalsy();
        expect(JSON.parse((sent.content as [{ text: string }])[0]!.text)).toMatchObject({ from: `opencode:${A}`, to: "human" });
      } finally {
        await c.close();
      }
    } finally {
      a.close();
    }
  });

  test("any other email is refused at the door", async () => {
    await expect(connectEmail("someone.else@example.com")).rejects.toThrow();
  });

  test("without HUB_OWNER_EMAIL even the owner is a stranger", async () => {
    const { createVerifier } = await import("@/auth");
    const { parsePrincipals } = await import("@/config");
    const verify = createVerifier({
      host: "127.0.0.1",
      port: 0,
      dbFile: ":memory:",
      access: { teamDomain: TEAM, audience: AUD, jwksUrl: `http://127.0.0.1:${jwks.port}/certs` },
      principals: parsePrincipals("mac.access=mac:mac:human"),
      ownerEmail: null,
    });
    await expect(verify(await emailToken("owner@example.com"))).rejects.toThrow("only service tokens and the owner may use the hub");
  });
});

describe("mcp tools", () => {
  test("directory lists what the machine publishes", async () => {
    await publish([["dirbot", A]]);
    const c = await connect("mac.access");
    try {
      const result = await c.callTool({ name: "hub_directory", arguments: {} });
      const entries = JSON.parse((result.content as [{ text: string }])[0]!.text) as [{ address: string }];
      expect(entries.some((e) => e.address === "bot:dirbot")).toBe(true);
    } finally {
      await c.close();
    }
  });

  test("an uncurated session is refused by the hub, not by the caller", async () => {
    // B streams but belongs to no Bot, so the sender passes the liveness check and fails curation.
    const b = await streamSession(B);
    const c = await connect("mac.access");
    try {
      const result = await c.callTool({ name: "hub_send", arguments: { to: "human", body: "hi", kind: "report", session_id: B } });
      expect(result.isError).toBe(true);
      expect((result.content as [{ text: string }])[0]!.text).toContain("no published Bot");
    } finally {
      await c.close();
      b.close();
    }
  });

  test("send, inbox and reply round-trip through streams the sidecar would hold", async () => {
    const a = await streamSession(A);
    const b = await streamSession(B);
    try {
      await publish([["abot", A], ["bbot", B]]);
      const c = await connect("mac.access");
      try {
        const sent = await c.callTool({ name: "hub_send", arguments: { to: "bot:bbot", body: "do the thing", kind: "request", session_id: A } });
        expect(sent.isError).toBeFalsy();
        const message = JSON.parse((sent.content as [{ text: string }])[0]!.text) as { id: string; to: string };
        expect(message.to).toBe("bot:bbot");

        const event = await b.next();
        expect(event).toMatchObject({ type: "message" });
        const confirmed = await rpc(`/v1/messages/${message.id}/delivered`, { as: "mac.access", method: "POST", body: JSON.stringify({ stream: b.streamId }) });
        expect(confirmed.status).toBe(200);

        const inbox = await c.callTool({ name: "hub_inbox", arguments: {} });
        const items = JSON.parse((inbox.content as [{ text: string }])[0]!.text) as [{ id: string }];
        expect(items.some((m) => m.id === message.id)).toBe(true);

        const reply = await c.callTool({ name: "hub_reply", arguments: { message_id: message.id, body: "done" } });
        expect(reply.isError).toBeFalsy();
        const answer = await a.next();
        expect(answer).toMatchObject({ type: "message" });
      } finally {
        await c.close();
      }
    } finally {
      a.close();
      b.close();
    }
  });
});
