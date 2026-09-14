import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ClaudeLiveBackend } from "@/live/claudeLiveBackend";
import type { ObserverEvent } from "@/live/claudeNetworkSource";

const flush = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FixtureServer {
  url: URL;
  stop(): void;
}

function startFixture(): FixtureServer {
  const bodyFor = (reference: string): string => {
    if (reference === "missing") return "not-an-identity";
    if (reference === "subagent1") {
      // A subagent's request: its parent's identity, plus the harness's billing token saying whose
      // turn it really is. Both are what the wire carries.
      return JSON.stringify({
        system: [{
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.268.58f; cc_entrypoint=cli;"
            + " cc_is_subagent=true; cc_prompt_id=2a5f44c0-0db0-4745-a365-df4dadab823b;",
        }],
        user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-b1" }),
      });
    }
    if (reference === "summariser1") {
      // A compaction summariser: the session's OWN identity, no subagent token, and a billing
      // header with no `cc_prompt_id` because there is no prompt behind it. Measured on the wire.
      return JSON.stringify({
        system: [{
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.270.d34; cc_entrypoint=cli;"
            + " cch=014d3; cc_prev_req=req_011Cf2s9jyovKWXfRAHetSU6;",
        }],
        user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-b1" }),
      });
    }
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

function flowEvent(
  flowId: string,
  path: string,
  authority: string,
  bodyRef?: string,
  requestHeaders?: { name: string; value: string }[],
): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    flowUpserted: {
      flow: {
        flowId,
        protocol: "OBSERVED_PROTOCOL_SSE",
        path,
        authority,
        ...(bodyRef ? { requestBody: { value: bodyRef } } : {}),
        ...(requestHeaders ? { requestHeaders } : {}),
      },
    },
  };
}

/** The beta list a 1M run actually sends, trimmed; the real one carries a dozen more entries. */
const LONG_CONTEXT_BETAS = {
  name: "anthropic-beta",
  value: "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
};
const ORDINARY_BETAS = {
  name: "anthropic-beta",
  value: "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
};

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

  test("a subagent's stream stays out of the parent's live view", async () => {
    // The bug this pins: a subagent's request carries the PARENT's session_id, so before this its
    // whole answer bound to the parent's projection and appeared in the parent's transcript --
    // while the parent was blocked on the tool call that started it. The parent's own message from
    // the fixture above is still there and is still the only one.
    const before = await backend.page(sessionId, 0, 10, "nice");
    backend.acceptObserverEvent(flowEvent("sub1", "/v1/messages", "api.anthropic.com", "subagent1"));
    backend.acceptObserverEvent(delta("sub1", {
      type: "message_start",
      message: { id: "msg_sub", model: "claude-haiku-4-5", usage: { input_tokens: 4, output_tokens: 0 } },
    }));
    backend.acceptObserverEvent(delta("sub1", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    backend.acceptObserverEvent(delta("sub1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from the subagent" } }));
    backend.acceptObserverEvent(delta("sub1", { type: "message_stop" }));
    backend.acceptObserverEvent(ended("sub1"));
    await flush(160);
    const after = await backend.page(sessionId, 0, 10, "nice");
    expect(after.total).toBe(before.total);
    expect(JSON.stringify(after.events)).not.toContain("from the subagent");
  });

  test("a compaction summary stays out of the session it compacted", async () => {
    // The report this came from: a session compacted, and the feed's tail showed half the summary
    // instead of the compaction banner. The summariser runs under the session's own id and is not
    // a subagent, so nothing else was stopping it -- and it streams for minutes, right over the one
    // row that says the context was reset.
    const before = await backend.page(sessionId, 0, 10, "nice");
    backend.acceptObserverEvent(flowEvent("sum1", "/v1/messages", "api.anthropic.com", "summariser1"));
    backend.acceptObserverEvent(delta("sum1", {
      type: "message_start",
      message: { id: "msg_sum", model: "claude-haiku-4-5", usage: { input_tokens: 9, output_tokens: 0 } },
    }));
    backend.acceptObserverEvent(delta("sum1", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    backend.acceptObserverEvent(delta("sum1", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "This session is being continued from a previous conversation" },
    }));
    backend.acceptObserverEvent(delta("sum1", { type: "message_stop" }));
    backend.acceptObserverEvent(ended("sum1"));
    await flush(160);
    const after = await backend.page(sessionId, 0, 10, "nice");
    expect(after.total).toBe(before.total);
    expect(JSON.stringify(after.events)).not.toContain("continued from a previous conversation");
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

  test("a streamed tool call carries the same summary its durable row will", async () => {
    // The row's header reads `summary`; without it a live Bash row said only "Bash".
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("fb", "/v1/messages", "api.anthropic.com", "bash1"));
    local.acceptObserverEvent(delta("fb", { type: "message_start", message: { id: "msg_bash" } }));
    local.acceptObserverEvent(delta("fb", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_bash", name: "Bash" },
    }));
    local.acceptObserverEvent(delta("fb", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"git sta' } }));
    local.acceptObserverEvent(delta("fb", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'tus --short"}' } }));
    local.acceptObserverEvent(delta("fb", { type: "content_block_stop", index: 0 }));
    local.acceptObserverEvent(delta("fb", { type: "message_stop" }));
    await flush(160);
    const page = await local.page("sess-bash1", 0, 10, "nice");
    const block = page.events[0]!.blocks[0]!;
    expect(block.kind).toBe("tool_use");
    expect(block.input).toEqual({ command: "git status --short" });
    expect(block.summary).toBe("git status --short");
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

describe("the context tier a live request asked for", () => {
  const fixture = startFixture();
  afterAll(() => fixture.stop());

  const usageOf = async (flowId: string, bodyRef: string, headers: { name: string; value: string }[]) => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent(flowId, "/v1/messages", "api.anthropic.com", bodyRef, headers));
    await flush(80);
    local.acceptObserverEvent(delta(flowId, {
      type: "message_start",
      message: { id: `msg_${flowId}`, model: "claude-opus-5", usage: { input_tokens: 500_000 } },
    }));
    local.acceptObserverEvent(delta(flowId, { type: "message_stop" }));
    await flush(40);
    const usage = local.sessionUsage(`sess-${bodyRef}`);
    await local.dispose();
    return usage;
  };

  test("reads the million-token window off the request's own beta list", async () => {
    // A captured request cannot name its tier: the model field says `claude-opus-5` whichever
    // window the harness is running. Resolving from it alone reported 200,000 for every 1M
    // session the moment it started streaming, and the panel takes the newer of the live and
    // durable snapshots, so that reading won while the session was being watched.
    const usage = await usageOf("ftier1", "tier1", [LONG_CONTEXT_BETAS]);

    expect(usage?.limit).toBe(1_000_000);
    // The model is what the API said, unchanged: the tier is not part of the id it returns.
    expect(usage?.model).toBe("claude-opus-5");
  });

  test("leaves an ordinary run on its own window", async () => {
    // Measured: `claude -p --model claude-opus-5` sends this list, with no `context-1m-` in it.
    const usage = await usageOf("ftier2", "tier2", [ORDINARY_BETAS]);

    expect(usage?.limit).toBe(200_000);
  });

  test("a flow whose headers never arrived does not shrink a session already known to be 1M", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("ftier3", "/v1/messages", "api.anthropic.com", "tier3", [LONG_CONTEXT_BETAS]));
    await flush(80);
    local.acceptObserverEvent(flowEvent("ftier4", "/v1/messages", "api.anthropic.com", "tier3"));
    await flush(80);
    local.acceptObserverEvent(delta("ftier4", {
      type: "message_start",
      message: { id: "msg_tier4", model: "claude-opus-5", usage: { input_tokens: 500_000 } },
    }));
    local.acceptObserverEvent(delta("ftier4", { type: "message_stop" }));
    await flush(40);

    // Every request of a session carries the same beta list, so a flow that named none is one this
    // mirror failed to read rather than a session that changed tier.
    expect(local.sessionUsage("sess-tier3")?.limit).toBe(1_000_000);
    await local.dispose();
  });
});
