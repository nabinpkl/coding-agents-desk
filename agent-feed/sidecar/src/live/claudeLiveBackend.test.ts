import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ClaudeLiveBackend } from "./claudeLiveBackend.ts";
import type { ObserverEvent } from "./claudeNetworkSource.ts";

const flush = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FixtureServer {
  url: URL;
  stop(): void;
}

function startFixture(): FixtureServer {
  const bodyFor = (reference: string): string => {
    if (reference === "missing") return "not-an-identity";
    if (reference === "tool1") {
      return JSON.stringify({
        user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-tool1" }),
        messages: [
          { role: "user", content: "head" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "file.txt\nreadme.md" }] },
        ],
      });
    }
    return JSON.stringify({
      user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: `sess-${reference}` }),
    });
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/bodies/")) {
        const reference = url.pathname.slice("/v1/bodies/".length);
        return new Response(bodyFor(reference), { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // `server.port` is assigned after `serve` returns.
  return {
    url: new URL(`http://127.0.0.1:${(server as { port: number }).port}`),
    stop: () => server.stop(true),
  };
}

function flowEvent(flowId: string, path: string, authority: string, bodyRef?: string): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    flowUpserted: {
      flow: {
        flowId,
        protocol: "OBSERVED_PROTOCOL_SSE",
        path,
        authority,
        ...(bodyRef ? { requestBody: { value: bodyRef } } : {}),
      },
    },
  };
}

function delta(flowId: string, payload: unknown): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    streamDeltaObserved: {
      flowId,
      sequence: "1",
      eventType: "message",
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    },
  };
}

function ended(flowId: string): ObserverEvent {
  return { observedAt: new Date().toISOString(), streamEnded: { flowId } };
}

describe("ClaudeLiveBackend ingest", () => {
  let fixture: FixtureServer;
  let backend: ClaudeLiveBackend;
  const sessionId = "sess-b1";

  beforeAll(async () => {
    fixture = startFixture();
    backend = new ClaudeLiveBackend(fixture.url, true, 8);
    // Feed the full lifecycle of one message.
    backend.acceptObserverEvent(flowEvent("f1", "/v1/messages", "api.anthropic.com", "b1"));
    backend.acceptObserverEvent(delta("f1", {
      type: "message_start",
      message: { id: "msg_123", model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 0 } },
    }));
    backend.acceptObserverEvent(delta("f1", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    backend.acceptObserverEvent(delta("f1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }));
    backend.acceptObserverEvent(delta("f1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }));
    backend.acceptObserverEvent(delta("f1", { type: "message_stop" }));
    backend.acceptObserverEvent(ended("f1"));
    await flush(160);
  });

  afterAll(async () => {
    await backend.dispose();
    fixture.stop();
  });

  test("binds the flow to its request session_id and mirrors the streaming message", async () => {
    const page = await backend.page(sessionId, 0, 10, "nice");
    expect(page.mode).toBe("nice");
    expect(page.total).toBe(1);
    const event = page.events[0]!;
    expect(event.type).toBe("assistant");
    expect(event.phase).toBe("complete");
    expect(event.blocks[0]!.kind).toBe("text");
    expect(event.blocks[0]!.text).toBe("Hello world");
    expect(event.revision).toBeGreaterThan(0);
    expect(page.sequence).toBeGreaterThan(0);
  });

  test("tracks context-window occupancy from message usage", () => {
    const usage = backend.sessionUsage(sessionId);
    expect(usage?.current).toBe(10);
    expect(usage?.model).toBe("claude-haiku-4-5");
  });

  test("raw and nice both serve the same live events", async () => {
    const nice = await backend.page(sessionId, 0, 10, "nice");
    const raw = await backend.page(sessionId, 0, 10, "raw");
    expect(raw.mode).toBe("raw");
    expect(raw.total).toBe(nice.total);
    expect(raw.events[0]!.blocks[0]!.text).toBe("Hello world");
    expect(raw.events[0]!.otherModeIndex).toBe(raw.events[0]!.index);
  });

  test("message_delta usage stamps the assistant row with the cache badge", async () => {
    const probe = new ClaudeLiveBackend(fixture.url, true, 8);
    const probeSession = "sess-cache";
    probe.acceptObserverEvent(flowEvent("fc", "/v1/messages", "api.anthropic.com", "cache"));
    probe.acceptObserverEvent(delta("fc", {
      type: "message_start",
      message: { id: "msg_cache", model: "claude-haiku-4-5", usage: { input_tokens: 0, output_tokens: 0 } },
    }));
    probe.acceptObserverEvent(delta("fc", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    probe.acceptObserverEvent(delta("fc", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cached turn" } }));
    probe.acceptObserverEvent(delta("fc", {
      type: "message_delta",
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 400,
        output_tokens: 50,
      },
    }));
    probe.acceptObserverEvent(delta("fc", { type: "message_stop" }));
    probe.acceptObserverEvent(ended("fc"));
    await flush(160);

    const page = await probe.page(probeSession, 0, 10, "nice");
    expect(page.total).toBe(1);
    // Meter includes the cache: 100 + 200 + 400 + 50.
    expect(probe.sessionUsage(probeSession)?.current).toBe(750);
    // Badge: 400 of 700 prompt tokens came from the cache.
    expect(page.events[0]!.cacheHit).toEqual({ cached: 400, input: 700 });
    await probe.dispose();
  });

  test("unknown source session 404s on page", async () => {
    await expect(backend.page("sess-unknown", 0, 10, "nice")).rejects.toThrow();
  });

  test("non-message and non-anthropic flows are ignored", async () => {
    const probe = new ClaudeLiveBackend(fixture.url, true, 8);
    probe.acceptObserverEvent({ observedAt: new Date().toISOString(), flowUpserted: { flow: { flowId: "p", protocol: "OBSERVED_PROTOCOL_SSE", path: "/v1/environments/x/poll", authority: "api.anthropic.com" } } });
    probe.acceptObserverEvent({ observedAt: new Date().toISOString(), flowUpserted: { flow: { flowId: "q", protocol: "OBSERVED_PROTOCOL_SSE", path: "/v1/messages", authority: "example.com" } } });
    await expect(probe.page("sess-p", 0, 10, "nice")).rejects.toThrow();
    await probe.dispose();
  });

  test("a message arriving before the body bind is buffered, not dropped", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("f2", "/v1/messages", "api.anthropic.com", "b2"));
    // These arrive before the body fetch resolves.
    local.acceptObserverEvent(delta("f2", { type: "message_start", message: { id: "msg_200" } }));
    local.acceptObserverEvent(delta("f2", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(delta("f2", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
    local.acceptObserverEvent(delta("f2", { type: "message_stop" }));
    await flush(80);
    const page = await local.page("sess-b2", 0, 10, "nice");
    expect(page.events[0]!.blocks[0]!.text).toBe("ok");
    await local.dispose();
  });

  test("tool results carried in the follow-up request body become user events", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("t1", "/v1/messages", "api.anthropic.com", "tool1"));
    await flush(80);
    const page = await local.page("sess-tool1", 0, 10, "nice");
    expect(page.total).toBe(1);
    const user = page.events[0]!;
    expect(user.type).toBe("user");
    expect(user.blocks[0]!.kind).toBe("tool_result");
    expect(user.blocks[0]!.callId).toBe("toolu_9");
    expect(user.blocks[0]!.preview).toBe("file.txt\nreadme.md");
    await local.dispose();
  });

  test("subscribers receive upsert envelopes as deltas land", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("f3", "/v1/messages", "api.anthropic.com", "b3"));
    await flush(160);
    const envelopes: Array<{ kind: string; phase: string; text: string; revision: number }> = [];
    await local.subscribe("sess-b3", 0, (envelope) => {
      const event = envelope.events[0];
      envelopes.push({
        kind: envelope.kind,
        phase: event?.phase ?? "none",
        text: event ? (event.blocks[0]?.text ?? "") : "",
        revision: event?.revision ?? 0,
      });
    });
    local.acceptObserverEvent(delta("f3", { type: "message_start", message: { id: "msg_300" } }));
    local.acceptObserverEvent(delta("f3", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(delta("f3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }));
    local.acceptObserverEvent(delta("f3", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } }));
    local.acceptObserverEvent(delta("f3", { type: "message_stop" }));
    await flush(40);
    const last = envelopes.at(-1);
    expect(last?.kind).toBe("upsert");
    expect(last?.text).toBe("ab");
    expect(last?.phase).toBe("complete");
    expect(last?.revision).toBeGreaterThanOrEqual(2);
    await local.dispose();
  });
});