import { expect, test } from "bun:test";
import type { SessionMessage } from "@opencode-ai/sdk/v2/client";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import { OpencodeEventMapper } from "@/agents/opencode/opencodeEventMapper";

function user(id: string, text: string): SessionMessage {
  return { id, time: { created: 100 }, text, type: "user" };
}

function assistant(
  id: string,
  content: SessionMessage extends never ? never : Extract<SessionMessage, { type: "assistant" }>["content"],
  completed: number | undefined,
): SessionMessage {
  return {
    id,
    time: completed === undefined ? { created: 200 } : { created: 200, completed },
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    content,
  };
}

test("a user message arrives as a human turn", () => {
  const projection = new LiveAgentProjection();
  const result = new OpencodeEventMapper(projection).sync([user("msg-u", "hello")]);
  expect(result.lastTurnClosed).toBe(true);
  expect(result.open).toBe(false);
  expect(projection.page(0, 10)).toEqual([
    expect.objectContaining({
      id: "opencode:msg-u",
      type: "user",
      humanTurn: true,
      phase: "complete",
      blocks: [{ kind: "text", text: "hello" }],
    }),
  ]);
});

test("newest-first serve order lands chronological, prompt before its reply", () => {
  const projection = new LiveAgentProjection();
  const reply = assistant("msg-a2", [{ type: "text", id: "t2", text: "done" }], 400);
  reply.time.created = 300;
  const prompt = user("msg-u2", "do it");
  prompt.time.created = 250;
  const old = user("msg-u1", "hi");
  // Serve order, newest first: the prompt must still read before its reply.
  new OpencodeEventMapper(projection).sync([reply, prompt, old]);
  expect(projection.page(0, 10).map((row) => row.id)).toEqual([
    "opencode:msg-u1",
    "opencode:msg-u2",
    "opencode:msg-a2",
  ]);
});

test("a finished turn carries text, thinking, and a paired tool call", () => {
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([
    user("msg-u", "run it"),
    assistant("msg-a", [
      { type: "text", id: "t1", text: "on it" },
      { type: "reasoning", id: "r1", text: "" },
      {
        type: "tool",
        id: "c1",
        name: "shell",
        state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], structured: {} },
        time: { created: 1, ran: 2, completed: 3 },
      },
    ], 300),
  ]);
  const rows = projection.page(0, 10);
  expect(rows[1]).toEqual(expect.objectContaining({
    id: "opencode:msg-a",
    type: "assistant",
    phase: "complete",
    blocks: [
      { kind: "text", text: "on it" },
      // Encrypted thinking is present-but-empty, never dropped.
      { kind: "reasoning", text: "" },
      {
        kind: "tool_use",
        tool: "shell",
        callId: "c1",
        input: { command: "ls" },
        summary: "shell",
        files: undefined,
      },
      { kind: "tool_result", callId: "c1", text: "ok", preview: "ok" },
    ],
  }));
});

test("an unfinished assistant message streams", () => {
  const projection = new LiveAgentProjection();
  const result = new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [{ type: "text", id: "t1", text: "working" }], undefined),
  ]);
  expect(result.open).toBe(true);
  expect(result.lastTurnClosed).toBe(false);
  expect(projection.page(0, 10)[0]).toEqual(expect.objectContaining({ phase: "streaming" }));
});

test("a re-sync that changed nothing publishes nothing", () => {
  const projection = new LiveAgentProjection();
  const mapper = new OpencodeEventMapper(projection);
  const items = [user("msg-u", "hello")];
  mapper.sync(items);
  const first = projection.page(0, 10)[0]!;
  mapper.sync(items);
  expect(projection.page(0, 10)[0]).toBe(first);
});

test("short tool results carry a preview, which is what the panel renders", () => {
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [
      {
        type: "tool",
        id: "c1",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "echo hi" },
          content: [{ type: "text", text: "hi\n" }],
          structured: {},
        },
        time: { created: 1, ran: 2, completed: 3 },
      },
    ], 300),
  ]);
  const result = projection.page(0, 10)[0]!.blocks.at(-1)!;
  expect(result.kind).toBe("tool_result");
  if (result.kind === "tool_result") {
    // Without `preview` the panel reads the block as "(empty result)".
    expect(result.preview).toBe("hi\n");
  }
});

test("long tool output is capped with a footer", () => {
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [
      {
        type: "tool",
        id: "c1",
        name: "shell",
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: `${"x".repeat(9000)}\nline2\nline3` }],
          structured: {},
        },
        time: { created: 1, ran: 2, completed: 3 },
      },
    ], 300),
  ]);
  const result = projection.page(0, 10)[0]!.blocks.at(-1)!;
  expect(result.kind).toBe("tool_result");
  if (result.kind === "tool_result") {
    expect(result.hiddenChars).toBeGreaterThan(0);
    expect(result.hiddenLines).toBe(2);
  }
});

test("a landed compaction arrives as a banner carrying its summary", () => {
  const projection = new LiveAgentProjection();
  const compaction: SessionMessage = {
    id: "msg-c",
    type: "compaction",
    reason: "auto",
    summary: "## Summary\n1. Primary Request",
    recent: "recent context",
    time: { created: 400 },
  };
  const result = new OpencodeEventMapper(projection).sync([user("msg-u", "hi"), compaction]);
  expect(result.lastTurnClosed).toBe(true);
  const rows = projection.page(0, 10);
  expect(rows.map((row) => row.id)).toEqual(["opencode:msg-u", "opencode:msg-c"]);
  const banner = rows[1]!;
  expect(banner.type).toBe("system");
  expect(banner.phase).toBe("complete");
  // The panel reads the banner's summary from the block's text, not its metadata.
  expect(banner.blocks).toEqual([
    expect.objectContaining({ kind: "compaction", text: "## Summary\n1. Primary Request" }),
  ]);
});
