import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { LiveAgentProjection } from "./liveAgentProjection.ts";
import { PiEventMapper } from "./piEventMapper.ts";

function assistant(text: string, stopReason: "pending" | "stop" = "pending") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 42,
  };
}

describe("PiEventMapper", () => {
  test("updates one assistant item through streaming completion", () => {
    const projection = new LiveAgentProjection();
    const mapper = new PiEventMapper(projection);
    mapper.accept({ type: "message_start", message: assistant("") });
    mapper.accept({
      type: "message_update",
      message: assistant("hel"),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant("hel") },
    });
    mapper.accept({ type: "message_end", message: assistant("hello", "stop") });
    expect(projection.page(0, 10)).toEqual([
      expect.objectContaining({
        id: "message:0:assistant:42",
        index: 0,
        revision: 2,
        phase: "complete",
        blocks: [{ kind: "text", text: "hello" }],
      }),
    ]);
  });

  test("keeps a tool result stable through start, update and end", () => {
    const projection = new LiveAgentProjection();
    const mapper = new PiEventMapper(projection);
    mapper.accept({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } });
    mapper.accept({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" }, partialResult: { content: [{ type: "text", text: "/tmp" }] } });
    mapper.accept({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "/tmp/project" }] }, isError: false });
    expect(projection.page(0, 10)).toEqual([
      expect.objectContaining({
        id: "tool:call-1",
        index: 0,
        revision: 2,
        phase: "complete",
        blocks: [expect.objectContaining({ kind: "tool_result", tool: "bash", callId: "call-1", preview: "/tmp/project" })],
      }),
    ]);
  });

  test("queue updates change session state without adding a row", () => {
    const projection = new LiveAgentProjection();
    const mapper = new PiEventMapper(projection);
    mapper.accept({ type: "agent_start" });
    mapper.accept({ type: "queue_update", steering: ["now"], followUp: ["later"] });
    expect(projection.runState).toBe("running");
    expect(projection.queue).toEqual({ steer: 1, followUp: 1 });
    expect(projection.total).toBe(0);
  });

  test("maps unknown notices without leaking unbounded structures", () => {
    const projection = new LiveAgentProjection();
    const mapper = new PiEventMapper(projection);
    mapper.accept({ type: "session_info_changed", name: "A" } satisfies AgentSessionEvent);
    expect(projection.page(0, 10)[0]).toMatchObject({
      type: "system",
      blocks: [{ kind: "metadata", label: "Session", text: "A" }],
    });
  });

  test("keeps distinct same-role messages that share a millisecond", () => {
    const projection = new LiveAgentProjection();
    const mapper = new PiEventMapper(projection);
    const first = {
      role: "custom" as const,
      customType: "status",
      content: "one",
      display: true,
      timestamp: 42,
    };
    const second = { ...first, content: "two" };

    mapper.seed([first, second]);

    expect(projection.page(0, 10)).toEqual([
      expect.objectContaining({ id: "message:0:custom:42", index: 0 }),
      expect.objectContaining({ id: "message:1:custom:42", index: 1 }),
    ]);
  });
});
