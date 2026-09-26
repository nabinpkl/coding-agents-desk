import { describe, expect, test } from "bun:test";
import type { Message } from "@agentdesk/agent-feed-wire";
import { HubOpencodeAdapter, messagePrompt, type OpencodeSessionRef } from "@/messaging/hubOpencode";
import { HubClient } from "@/messaging/hubClient";

interface FakeStream {
  session: string;
  source?: string;
  emit(event: unknown): void;
  closed(): boolean;
}

function fakeHub(): { hub: HubClient; streams: FakeStream[]; posts: { path: string; body: unknown }[] } {
  const streams: FakeStream[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/stream") {
        const encoder = new TextEncoder();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const entry: FakeStream = {
          session: url.searchParams.get("session") ?? "",
          source: url.searchParams.get("source") ?? undefined,
          emit: (event) => controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
          closed: () => controller === undefined,
        };
        streams.push(entry);
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
          cancel() {
            controller = undefined;
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      posts.push({ path: url.pathname, body: await request.json() });
      return Response.json({ ok: true });
    },
  });
  const hub = new HubClient({ url: `http://127.0.0.1:${server.port}`, machine: "mac", clientId: "cid", clientSecret: "secret" });
  return { hub, streams, posts };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "m1",
    inReplyTo: null,
    from: "human",
    fromKind: "human",
    to: "bot:one",
    toSession: "opencode:ses_1",
    kind: "request",
    body: "fix it",
    refs: [],
    hops: 0,
    state: "pushed",
    deliveredTo: "opencode:ses_1",
    deliveredAt: null,
    answeredBy: null,
    createdAt: "2026-09-25T10:00:00.000Z",
    expiresAt: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Bun.sleep(5);
}

describe("messagePrompt", () => {
  test("carries the same facts the channel meta does, plus the refs", () => {
    const prompt = messagePrompt(message({ refs: [{ app: "agentdesk-annotator", kind: "annotation", id: "14" }] }), "owner");
    expect(prompt).toContain('<channel source="agentdesk-relay"');
    expect(prompt).toContain('message_id="m1"');
    expect(prompt).toContain('from="human"');
    expect(prompt).toContain('from_kind="human"');
    expect(prompt).toContain('kind="request"');
    expect(prompt).toContain("- agentdesk-annotator annotation 14");
    expect(prompt.trimEnd().endsWith("</channel>")).toBe(true);
  });
});

describe("HubOpencodeAdapter", () => {
  test("one stream per serve session, delivered as a queued prompt, then confirmed", async () => {
    const { hub, streams, posts } = fakeHub();
    const prompts: { sessionId: string; requestId: string; text: string }[] = [];
    let listed: OpencodeSessionRef[] = [{ sessionId: "ses_1", cwd: "/work/site", title: "Fixer" }];
    const adapter = new HubOpencodeAdapter({
      hub,
      serve: {
        sessions: async () => listed,
        prompt: async (sessionId, requestId, text) => void prompts.push({ sessionId, requestId, text }),
        onChanged: () => () => {},
      },
      log: () => {},
      sleep: async () => {},
    });
    adapter.start();
    await settle();
    expect(streams.map((s) => [s.session, s.source])).toEqual([["ses_1", "opencode"]]);

    streams[0]!.emit({ type: "hello", address: "opencode:ses_1", channel: true, streamId: "s1" });
    streams[0]!.emit({ type: "message", message: message(), fromName: "owner", streamId: "s1" });
    await settle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe("ses_1");
    expect(prompts[0]!.requestId).toBe("m1");
    expect(prompts[0]!.text).toContain("fix it");
    expect(posts.at(-1)).toEqual({ path: "/v1/messages/m1/delivered", body: { stream: "s1" } });
    adapter.stop();
  });

  test("a failed prompt is not confirmed, so the message waits for redelivery", async () => {
    const { hub, streams, posts } = fakeHub();
    const adapter = new HubOpencodeAdapter({
      hub,
      serve: {
        sessions: async () => [{ sessionId: "ses_1", cwd: "/work/site", title: "" }],
        prompt: async () => {
          throw new Error("serve answered 404");
        },
        onChanged: () => () => {},
      },
      log: () => {},
      sleep: async () => {},
    });
    adapter.start();
    await settle();
    streams[0]!.emit({ type: "hello", address: "opencode:ses_1", channel: true, streamId: "s1" });
    streams[0]!.emit({ type: "message", message: message(), fromName: "owner", streamId: "s1" });
    await settle();
    expect(posts.filter((p) => p.path.endsWith("/delivered"))).toHaveLength(0);
    adapter.stop();
  });

  test("a session the serve drops has its stream closed", async () => {
    const { hub, streams } = fakeHub();
    let listed: OpencodeSessionRef[] = [{ sessionId: "ses_1", cwd: "/work/site", title: "" }];
    const adapter = new HubOpencodeAdapter({
      hub,
      serve: {
        sessions: async () => listed,
        prompt: async () => {},
        onChanged: () => () => {},
      },
      log: () => {},
      sleep: async () => {},
    });
    adapter.start();
    await settle();
    expect(adapter.connected).toEqual(["ses_1"]);
    listed = [];
    await adapter.sync();
    expect(adapter.connected).toEqual([]);
    adapter.stop();
  });

  test("no serve means no streams, and it says why", async () => {
    const logs: string[] = [];
    const { hub, streams } = fakeHub();
    const adapter = new HubOpencodeAdapter({
      hub,
      serve: {
        sessions: async () => {
          throw new Error("serve is down");
        },
        prompt: async () => {},
        onChanged: () => () => {},
      },
      log: (line) => void logs.push(line),
      sleep: async () => {},
    });
    adapter.start();
    await settle();
    expect(streams).toHaveLength(0);
    expect(logs[0]).toContain("serve is down");
    adapter.stop();
  });
});
