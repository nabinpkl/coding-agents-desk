import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CodexLiveBackend } from "@/live/codexLiveBackend";
import type { ObserverEvent } from "@/live/claudeNetworkSource";
import { state } from "@/transcripts/transcriptState";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { summarizeToolUse } from "@/transcripts/codex/codexPayloads";

const FIXTURE_PATH = resolve(import.meta.dir, "fixtures/codexDesktopLiveFixture.jsonl");
const SESSION_ID = "019fe292-5466-7393-b931-8bf0c2cece82";

const flush = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function loadFixtureEvents(): ObserverEvent[] {
  const events: ObserverEvent[] = [];
  for (const line of readFileSync(FIXTURE_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    events.push(JSON.parse(trimmed) as ObserverEvent);
  }
  return events;
}

function messageEvent(flowId: string, payload: unknown, direction = "TRAFFIC_DIRECTION_SERVER_TO_CLIENT"): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    websocketMessageObserved: {
      flowId,
      sequence: "1",
      direction,
      kind: "WEBSOCKET_MESSAGE_KIND_TEXT",
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    },
  };
}

function upsertEvent(flowId: string, extra: Record<string, unknown> = {}): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    flowUpserted: {
      flow: {
        flowId,
        protocol: "OBSERVED_PROTOCOL_WEBSOCKET",
        authority: "chatgpt.com",
        path: "/backend-api/codex/responses",
        requestHeaders: [
          { name: "session-id", value: SESSION_ID },
          { name: "thread-id", value: SESSION_ID },
          { name: "x-codex-window-id", value: `${SESSION_ID}:0` },
        ],
        ...extra,
      },
    },
  };
}

function endedEvent(flowId: string): ObserverEvent {
  return { observedAt: new Date().toISOString(), streamEnded: { flowId } };
}

describe("CodexLiveBackend fixture ingest", () => {
  let backend: CodexLiveBackend;

  beforeAll(() => {
    backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 16);
    for (const event of loadFixtureEvents()) {
      backend.acceptObserverEvent(event);
    }
  });

  afterAll(async () => {
    await backend.dispose();
  });

  test("binds the flow to its header session id and mirrors the conversation", async () => {
    const page = await backend.page(SESSION_ID, 0, 100, "nice");
    expect(page.total).toBeGreaterThan(5);
    const events = page.events;
    const userRows = events.filter((event) => event.type === "user");

    // The turn's user prompt rides in response.create input.
    const promptRow = userRows.find((event) =>
      event.blocks.some((block) => block.kind === "text" && block.text === "stream\n"));
    expect(promptRow).toBeDefined();
    expect(promptRow!.phase).toBe("complete");

    // Tool results ride in the follow-up response.create input and pair by callId.
    const resultRow = userRows.find((event) =>
      event.blocks.some((block) => block.kind === "tool_result" && block.callId === "call_XSwFAAx1PgHxPOBunSaT89tH"));
    expect(resultRow).toBeDefined();
    const resultBlock = resultRow!.blocks[0]!;
    expect(resultBlock.kind).toBe("tool_result");
    expect(resultBlock.preview!.startsWith("Chunk ID: 861f58")).toBe(true);
    expect(resultBlock.hiddenChars).toBeUndefined();
  });

  test("mirrors the assistant stream: reasoning, text, and tool calls", async () => {
    const page = await backend.page(SESSION_ID, 0, 100, "nice");
    const events = page.events;

    const reasoning = events.find((event) =>
      event.blocks.some((block) => block.kind === "reasoning" && block.text === "**Investigating user intent for streaming**"));
    expect(reasoning).toBeDefined();
    expect(reasoning!.phase).toBe("complete");

    const text = events.find((event) =>
      event.blocks.some((block) => block.kind === "text" && block.text!.startsWith("I’m checking the current workspace state")));
    expect(text).toBeDefined();
    expect(text!.phase).toBe("complete");
    // Accumulated from many deltas.
    expect(text!.revision).toBeGreaterThan(0);

    const tool = events.find((event) =>
      event.blocks.some((block) => block.kind === "tool_use" && block.callId === "call_XSwFAAx1PgHxPOBunSaT89tH"));
    expect(tool).toBeDefined();
    const toolBlock = tool!.blocks[0]!;
    expect(toolBlock.kind).toBe("tool_use");
    expect(toolBlock.tool).toBe("exec_command");
    expect(toolBlock.input).toBeTypeOf("object");
    expect((toolBlock.input as Record<string, unknown>).workdir).toBe("/workdir");
    expect((toolBlock.input as Record<string, unknown>).cmd).toBeTypeOf("string");
    // The live row's header reads `summary`, and the durable row that replaces it must say the same.
    const input = toolBlock.input as Record<string, unknown>;
    expect(toolBlock.summary).not.toBe("exec_command");
    expect(toolBlock.summary).toBe(summarizeToolUse("exec_command", input, JSON.stringify(input)));
    expect(tool!.phase).toBe("complete");
  });

  test("tracks usage from response.completed and ends idle", async () => {
    const usage = backend.sessionUsage(SESSION_ID);
    expect(usage?.current).toBeGreaterThan(0);
    expect(usage?.model).toBe("gpt-5.4-mini-2026-03-17");
    const page = await backend.page(SESSION_ID, 0, 100, "nice");
    expect(page.runState).toBe("idle");
  });

  test("response.completed stamps the turn's last assistant row with the cache badge", async () => {
    const page = await backend.page(SESSION_ID, 0, 100, "nice");
    const badged = page.events.filter((event) => event.cacheHit);
    // Every response.completed in the fixture reports cached input.
    expect(badged.length).toBeGreaterThan(0);
    // The fixture's final response.completed usage: input 26449 (which already
    // includes cached), cached 25984 -- the badge reads the full input, not
    // input + cached.
    const last = badged[badged.length - 1]!;
    expect(last.cacheHit).toEqual({ cached: 25_984, input: 26_449 });
  });

  test("orders user rows before their turn's assistant rows", async () => {
    const page = await backend.page(SESSION_ID, 0, 100, "nice");
    const events = page.events;
    const promptIndex = events.findIndex((event) =>
      event.blocks.some((block) => block.kind === "text" && block.text === "stream\n"));
    const firstAssistantAfterPrompt = events
      .slice(promptIndex)
      .findIndex((event) => event.type === "assistant");
    expect(firstAssistantAfterPrompt).toBeGreaterThan(0);
  });

  test("raw and nice both serve the same live events", async () => {
    const nice = await backend.page(SESSION_ID, 0, 100, "nice");
    const raw = await backend.page(SESSION_ID, 0, 100, "raw");
    expect(raw.total).toBe(nice.total);
    expect(raw.events[0]!.otherModeIndex).toBe(raw.events[0]!.index);
  });
});

describe("CodexLiveBackend targeted ingest", () => {
  test("ignores non-codex flows and unknown sessions stay empty", async () => {
    const backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 8);
    backend.acceptObserverEvent({
      observedAt: new Date().toISOString(),
      flowUpserted: {
        flow: {
          flowId: "p",
          protocol: "OBSERVED_PROTOCOL_WEBSOCKET",
          authority: "chatgpt.com",
          path: "/backend-api/ps/mcp",
          requestHeaders: [{ name: "session-id", value: "other-session" }],
        },
      },
    });
    backend.acceptObserverEvent({
      observedAt: new Date().toISOString(),
      flowUpserted: {
        flow: {
          flowId: "q",
          protocol: "OBSERVED_PROTOCOL_WEBSOCKET",
          authority: "api.openai.com",
          path: "/backend-api/codex/responses",
          requestHeaders: [{ name: "session-id", value: "other-session" }],
        },
      },
    });
    // Non-codex flows never bind: the session is not describable and no events
    // ever land. (An unknown session pages empty rather than 404ing, because a
    // viewer may page a session before its first traffic.)
    expect(backend.describeSession("other-session")).toBeUndefined();
    const page = await backend.page("other-session", 0, 10, "nice");
    expect(page.total).toBe(0);
    await backend.dispose();
  });

  test("streams a turn incrementally to subscribers and closes it on streamEnded", async () => {
    const backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 8);
    backend.acceptObserverEvent(upsertEvent("f1"));
    await flush();
    const phases: string[] = [];
    const texts: string[] = [];
    await backend.subscribe(SESSION_ID, 0, (envelope) => {
      for (const event of envelope.events) {
        if (event.blocks[0]?.kind === "text") {
          phases.push(event.phase);
          texts.push(event.blocks[0].text ?? "");
        }
      }
    });
    backend.acceptObserverEvent(messageEvent("f1", {
      type: "response.create",
      model: "gpt-5.4-mini",
      input: [{ type: "message", id: "msg_123", role: "user", content: [{ type: "input_text", text: "hi\n" }] }],
    }));
    backend.acceptObserverEvent(messageEvent("f1", { type: "response.created" }));
    backend.acceptObserverEvent(messageEvent("f1", { type: "response.output_item.added", item: { id: "msg_456", type: "message" } }));
    backend.acceptObserverEvent(messageEvent("f1", { type: "response.output_text.delta", item_id: "msg_456", delta: "Hel" }));
    backend.acceptObserverEvent(messageEvent("f1", { type: "response.output_text.delta", item_id: "msg_456", delta: "lo" }));
    await flush();
    expect(texts.at(-1)).toBe("Hello");
    expect(phases.at(-1)).toBe("streaming");
    backend.acceptObserverEvent(endedEvent("f1"));
    await flush();
    const page = await backend.page(SESSION_ID, 0, 10, "nice");
    const textRow = page.events.find((event) =>
      event.blocks.some((block) => block.kind === "text" && block.text === "Hello"));
    expect(textRow).toBeDefined();
    expect(textRow!.phase).toBe("complete");
    await backend.dispose();
  });

  test("tool results ride in the follow-up create and pair by callId", async () => {
    const backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 8);
    backend.acceptObserverEvent(upsertEvent("g1"));
    backend.acceptObserverEvent(messageEvent("g1", {
      type: "response.create",
      input: [{
        type: "function_call_output",
        id: "fco_1",
        call_id: "call_abc",
        output: "file.txt\nreadme.md",
      }],
    }));
    await flush();
    const page = await backend.page(SESSION_ID, 0, 10, "nice");
    const row = page.events.find((event) =>
      event.blocks.some((block) => block.kind === "tool_result" && block.callId === "call_abc"));
    expect(row).toBeDefined();
    expect(row!.blocks[0]!.preview).toBe("file.txt\nreadme.md");
    await backend.dispose();
  });

  test("live assistant rows carry the codex item id as messageId for tail handoff", async () => {
    const backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 8);
    backend.acceptObserverEvent(upsertEvent("h1"));
    backend.acceptObserverEvent(messageEvent("h1", { type: "response.output_item.added", item: { id: "msg_abc", type: "message" } }));
    backend.acceptObserverEvent(messageEvent("h1", { type: "response.output_text.delta", item_id: "msg_abc", delta: "hi" }));
    backend.acceptObserverEvent(messageEvent("h1", { type: "response.output_text.done", item_id: "msg_abc", text: "hi" }));
    await flush();
    const page = await backend.page(SESSION_ID, 0, 10, "nice");
    const row = page.events.find((event) => event.messageId === "msg_abc");
    expect(row).toBeDefined();
    expect(row!.type).toBe("assistant");
    expect(row!.blocks[0]!.text).toBe("hi");
    await backend.dispose();
  });
});

describe("CodexLiveBackend lazy attach", () => {
  test("describes a catalog codex session before any traffic and pages it empty", async () => {
    const project = "/tmp/codex-live-attach";
    state.sessions.set(sessionKey("codex", SESSION_ID), {
      source: "codex",
      sessionId: SESSION_ID,
      project,
      transcriptPath: "/tmp/codex-live-attach/rollout.jsonl",
      lastEventAt: Date.now(),
    });
    const backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 8);
    const descriptor = backend.describeSession(SESSION_ID);
    expect(descriptor).toBeDefined();
    expect(descriptor!.source).toBe("codex");
    expect(descriptor!.capabilities.canStreamLive).toBe(true);
    expect(descriptor!.activity).toBe("ready");
    const page = await backend.page(SESSION_ID, 0, 10, "nice");
    expect(page.total).toBe(0);
    await backend.dispose();
  });

  test("a subscription attaches before any traffic and receives the next turn", async () => {
    const backend = new CodexLiveBackend(new URL("http://127.0.0.1:9"), true, 8);
    const received: string[] = [];
    await backend.subscribe(SESSION_ID, 0, (envelope) => {
      for (const event of envelope.events) {
        const text = event.blocks[0]?.kind === "text" ? (event.blocks[0]?.text ?? "") : "";
        if (text.length > 0) received.push(text);
      }
    });
    backend.acceptObserverEvent(upsertEvent("j1"));
    backend.acceptObserverEvent(messageEvent("j1", { type: "response.output_item.added", item: { id: "msg_j1", type: "message" } }));
    backend.acceptObserverEvent(messageEvent("j1", { type: "response.output_text.delta", item_id: "msg_j1", delta: "attached" }));
    await flush();
    expect(received).toEqual(["attached"]);
    await backend.dispose();
  });
});
