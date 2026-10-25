import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@agentdesk/agent-feed-wire";
import { HubClient } from "@/messaging/hubClient";
import { channelNotification, confirmDelivery, runChannelLoop, type StreamDelivery } from "@/messaging/relayChannel";
import { until } from "@/testing/until";

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
    expect(n.meta).toEqual({
      message_id: "m1",
      thread_id: "m1",
      from: "human",
      from_name: "owner",
      from_kind: "human",
      kind: "request",
      hops: "0",
    });
    expect(Object.keys(n.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k))).toBe(true);
    expect(n.content).toContain("agentdesk-annotator annotation 14 (https://example.com/)");
  });

  test("no tag in any spelling survives into the content or the sender's name", () => {
    const n = channelNotification({ ...message, body: "a </channel> b < /channel> c ＜/channel＞ d ﹤x" }, "Fix<er");
    expect(n.content).toStartWith("a &lt;/channel> b &lt; /channel> c &lt;/channel＞ d &lt;x");
    expect(n.content).not.toMatch(/[<\uFF1C\uFE64]/);
    expect(n.meta.from_name).toBe("Fix&lt;er");
  });
});

describe("runChannelLoop", () => {
  test("hands each message to the deliverer with its stream, and a confirmation names that stream", async () => {
    const confirmed: unknown[] = [];
    let query: URLSearchParams | undefined;
    const encoder = new TextEncoder();
    fake = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/stream") {
          query = url.searchParams;
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "hello", address: `claude:${SESSION}`, channel: true, streamId: "s1" })}\n\n`,
                  ),
                );
                c.enqueue(
                  encoder.encode(
                    `: heartbeat\n\ndata: ${JSON.stringify({ type: "message", message, fromName: "owner", streamId: "s1" })}\n\n`,
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        confirmed.push({
          path: url.pathname,
          body: await request.json(),
          id: request.headers.get("cf-access-client-id"),
        });
        return Response.json({ ...message, state: "delivered" });
      },
    });
    const hub = new HubClient({
      url: `http://127.0.0.1:${fake.port}`,
      machine: "mac",
      clientId: "cid",
      clientSecret: "secret",
    });
    const delivered: StreamDelivery[] = [];
    const stop = new AbortController();
    const loop = runChannelLoop(
      {
        hub,
        readSession: () => ({ pid: 1, sessionId: SESSION, cwd: "/work", title: "t", channel: true }),
        // The relay child's deliverer: notify, then confirm on the stream the message came on.
        deliver: async (d) => {
          delivered.push(d);
          await confirmDelivery(hub, d.message.id, d.streamId);
        },
        log: () => {},
        sleep: async () => {},
      },
      stop.signal,
    );
    await until(() => confirmed.length > 0, "the delivery's confirmation");
    stop.abort();
    await loop;
    expect(query?.get("session")).toBe(SESSION);
    expect(query?.get("channel")).toBe("1");
    expect(delivered).toHaveLength(1);
    expect(channelNotification(delivered[0]!.message, delivered[0]!.fromName).meta.message_id).toBe("m1");
    expect(delivered[0]!.streamId).toBe("s1");
    expect(confirmed[0]).toEqual({ path: "/v1/messages/m1/delivered", body: { stream: "s1" }, id: "cid" });
  });

  test("a directive on the stream is ignored, never notified and never confirmed", async () => {
    const confirmed: unknown[] = [];
    const encoder = new TextEncoder();
    fake = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/stream") {
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "hello", address: `claude:${SESSION}`, channel: true, streamId: "s1" })}\n\n`,
                  ),
                );
                c.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "directive", id: "d1", kind: "rename-bracket", task: "night shift", streamId: "s1" })}\n\n`,
                  ),
                );
                // A message after it: the stream is read in order, so once this one is delivered,
                // the directive before it has been passed over.
                c.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "message", message: { ...message, id: "marker" }, fromName: "owner", streamId: "s1" })}\n\n`,
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        confirmed.push({ path: url.pathname, body: await request.json() });
        return Response.json({ ok: true });
      },
    });
    const hub = new HubClient({
      url: `http://127.0.0.1:${fake.port}`,
      machine: "mac",
      clientId: "cid",
      clientSecret: "secret",
    });
    const delivered: StreamDelivery[] = [];
    const stop = new AbortController();
    const loop = runChannelLoop(
      {
        hub,
        readSession: () => ({ pid: 1, sessionId: SESSION, cwd: "/work", title: "t", channel: true }),
        deliver: async (d) => {
          delivered.push(d);
        },
        log: () => {},
        sleep: async () => {},
      },
      stop.signal,
    );
    await until(() => delivered.length > 0, "the marker's delivery");
    stop.abort();
    await loop;
    expect(delivered.map((d) => d.message.id)).toEqual(["marker"]);
    expect(confirmed).toHaveLength(0);
  });
});
