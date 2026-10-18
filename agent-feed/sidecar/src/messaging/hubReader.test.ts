import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@agentdesk/agent-feed-wire";
import { HubClient } from "@/messaging/hubClient";
import { readerLine, runHubReader, watchParent } from "@/messaging/hubReader";

const SESSION = "0b1e8c52-1a8e-4a3a-9d3f-2f1f0f6c1a11";
const message = {
  id: "m1",
  threadId: "m1",
  inReplyTo: null,
  from: "human",
  fromKind: "human",
  to: "bot:probe",
  kind: "request",
  body: "hello from the owner",
  refs: [],
  hops: 0,
  state: "pushed",
  toSession: `claude:${SESSION}`,
  deliveredTo: null,
  deliveredAt: null,
  answeredBy: null,
  createdAt: "2026-10-16T09:00:00.000Z",
  expiresAt: "2026-10-23T09:00:00.000Z",
} satisfies Message;

let fake: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  fake?.stop(true);
  fake = undefined;
});

describe("runHubReader", () => {
  test("writes each message with its stream as one line, opens with the channel on, and confirms nothing", async () => {
    const other: string[] = [];
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
              c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message", message, fromName: "owner", streamId: "s1" })}\n\n`));
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        other.push(`${request.method} ${url.pathname}`);
        return Response.json({});
      },
    });
    const hub = new HubClient({ url: `http://127.0.0.1:${fake.port}`, machine: "mac", clientId: "cid", clientSecret: "secret" });
    const lines: string[] = [];
    const stop = new AbortController();
    const reader = runHubReader(
      { hub, sessionId: SESSION, cwd: "/work", title: "probe", write: (l) => lines.push(l), log: () => {}, sleep: async () => {} },
      stop.signal,
    );
    for (let i = 0; i < 50 && lines.length === 0; i++) await Bun.sleep(10);
    await Bun.sleep(50);
    stop.abort();
    await reader;

    expect(query?.get("session")).toBe(SESSION);
    expect(query?.get("source")).toBe("claude");
    expect(query?.get("channel")).toBe("1");
    expect(lines).toEqual([readerLine({ type: "message", streamId: "s1", fromName: "owner", message })]);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(lines[0]!.slice(0, -1).includes("\n")).toBe(false);
    expect(other).toEqual([]);
  });
});

describe("watchParent", () => {
  test("calls gone once the parent pid changes, and only then", async () => {
    let parent = 4242;
    let gone = 0;
    const stop = watchParent({ parentPid: () => parent, intervalMs: 5, gone: () => gone++ });
    await Bun.sleep(30);
    expect(gone).toBe(0);
    parent = 1;
    await Bun.sleep(30);
    stop();
    expect(gone).toBe(1);
  });
});
