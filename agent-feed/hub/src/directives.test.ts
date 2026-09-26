// set_task end to end against a live store: the MCP caller waits while the addressed session's
// stream carries the directive, and answers what the sidecar confirms.

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

async function rpc(path: string, init: RequestInit & { as?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.as) headers.set("cf-access-jwt-assertion", await token(init.as));
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${hub.port}${path}`, { ...init, headers });
}

async function tool(as: string, name: string, args: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }> {
  const c = new Client({ name: "directives-test", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${hub.port}/mcp`),
    { requestInit: { headers: { "cf-access-jwt-assertion": await token(as) } } },
  ));
  try {
    return await c.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  } finally {
    await c.close();
  }
}

/** Opens a hub stream the way the sidecar does, and reads frames off it. */
async function streamSession(session: string): Promise<{ next: () => Promise<Record<string, unknown>>; close: () => void }> {
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
  await next(); // hello
  return { next, close: () => void reader.cancel() };
}

async function publish(session: string): Promise<void> {
  const response = await rpc("/v1/directory/bots/mac", {
    as: "mac.access",
    method: "PUT",
    body: JSON.stringify({ bots: [{ botId: "bot-1", name: "bot-1", path: "/work", sessionIds: [`opencode:${session}`] }] }),
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

describe("set_task", () => {
  test("a directive rides the session's stream and the tool answers the confirm", async () => {
    await publish("ses_task_1");
    const stream = await streamSession("ses_task_1");
    try {
      const calling = tool("mac.access", "set_task", { session_id: "ses_task_1", task: "night shift" });
      const frame = await stream.next();
      expect(frame.type).toBe("directive");
      expect(frame.kind).toBe("rename-bracket");
      expect(frame.task).toBe("night shift");
      const id = frame.id as string;
      const done = await rpc(`/v1/directives/${id}/done`, {
        as: "mac.access",
        method: "POST",
        body: JSON.stringify({ ok: true, anchor: "Aaron", title: "Aaron (night shift)", status: "renamed" }),
      });
      expect(done.status).toBe(200);
      const answer = await calling;
      expect(answer.isError).toBeUndefined();
      expect(JSON.parse(answer.content[0]!.text)).toEqual({
        ok: true,
        anchor: "Aaron",
        title: "Aaron (night shift)",
        status: "renamed",
      });
    } finally {
      stream.close();
    }
  });

  test("a session with no live stream is refused, not queued", async () => {
    await publish("ses_task_dead");
    const answer = await tool("mac.access", "set_task", { session_id: "ses_task_dead", task: "night shift" });
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain("no live stream");
  });

  test("a session in no Bot does not take part", async () => {
    const stream = await streamSession("ses_task_lonely");
    try {
      const answer = await tool("mac.access", "set_task", { session_id: "ses_task_lonely", task: "night shift" });
      expect(answer.isError).toBe(true);
      expect(answer.content[0]!.text).toContain("in no published Bot");
    } finally {
      stream.close();
    }
  });

  test("a confirm from another machine is refused", async () => {
    await publish("ses_task_2");
    const stream = await streamSession("ses_task_2");
    try {
      const calling = tool("mac.access", "set_task", { session_id: "ses_task_2", task: "night shift" });
      const frame = await stream.next();
      const id = frame.id as string;
      // annotator speaks for no machine with a stream here: the pending entry remembers mac.
      const denied = await rpc(`/v1/directives/${id}/done`, {
        as: "annotator.access",
        method: "POST",
        body: JSON.stringify({ ok: true, title: "Aaron (night shift)" }),
      });
      expect(denied.status).toBe(403);
      const done = await rpc(`/v1/directives/${id}/done`, {
        as: "mac.access",
        method: "POST",
        body: JSON.stringify({ ok: true, anchor: "Aaron", title: "Aaron (night shift)", status: "renamed" }),
      });
      expect(done.status).toBe(200);
      const answer = await calling;
      expect(answer.isError).toBeUndefined();
    } finally {
      stream.close();
    }
  });
});
