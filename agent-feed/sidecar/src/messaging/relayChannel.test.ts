import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@agentdesk/agent-feed-wire";
import { HubClient } from "@/messaging/hubClient";
import { channelNotification, runChannelLoop, type ChannelNotification } from "@/messaging/relayChannel";

const SESSION = "55555555-5555-5555-5555-555555555555";

const message: Message = {
  id: "m1",
  threadId: "m1",
  inReplyTo: null,
  from: "human",
  fromKind: "human",
  to: "bot:one",
  toSession: `claude:${SESSION}`,
  kind: "request",
  body: "fix the header",
  refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "14", url: "https://example.com/" }],
  hops: 0,
  state: "pushed",
  deliveredTo: `claude:${SESSION}`,
  deliveredAt: null,
  answeredBy: null,
  createdAt: "2026-09-25T10:00:00Z",
  expiresAt: "2026-10-02T10:00:00Z",
};

let fake: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => fake?.stop(true));

describe("channelNotification", () => {
  test("carries routing in identifier-only meta keys and refs in the body", () => {
    const n = channelNotification(message, "owner");
    expect(n.meta).toEqual({ message_id: "m1", thread_id: "m1", from: "human", from_name: "owner", from_kind: "human", kind: "request", hops: "0" });
    expect(Object.keys(n.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k))).toBe(true);
    expect(n.content).toContain("agentdesk-annotator annotation 14 (https://example.com/)");
  });
});

describe("runChannelLoop", () => {
  test("pushes each message as a notification, then confirms it on the same stream", async () => {
    const confirmed: unknown[] = [];
    let query: URLSearchParams | undefined;
    const encoder = new TextEncoder();
    fake = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/stream") {
          query = url.searchParams;
          return new Response(new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "hello", address: `claude:${SESSION}`, channel: true, streamId: "s1" })}\n\n`));
              c.enqueue(encoder.encode(`: heartbeat\n\ndata: ${JSON.stringify({ type: "message", message, fromName: "owner", streamId: "s1" })}\n\n`));
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        confirmed.push({ path: url.pathname, body: await request.json(), id: request.headers.get("cf-access-client-id") });
        return Response.json({ ...message, state: "delivered" });
      },
    });
    const hub = new HubClient({ url: `http://127.0.0.1:${fake.port}`, machine: "mac", clientId: "cid", clientSecret: "secret" });
    const notes: ChannelNotification[] = [];
    const stop = new AbortController();
    const loop = runChannelLoop({
      hub,
      readSession: () => ({ pid: 1, sessionId: SESSION, cwd: "/work", title: "t", channel: true }),
      notify: async (n) => {
        notes.push(n);
      },
      log: () => {},
      sleep: async () => {},
    }, stop.signal);
    for (let i = 0; i < 50 && confirmed.length === 0; i++) await Bun.sleep(10);
    stop.abort();
    await loop;
    expect(query?.get("session")).toBe(SESSION);
    expect(query?.get("channel")).toBe("1");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.meta.message_id).toBe("m1");
    expect(confirmed[0]).toEqual({ path: "/v1/messages/m1/delivered", body: { stream: "s1" }, id: "cid" });
  });
});
