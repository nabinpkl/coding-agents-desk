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
        // The chip already says shell, so the summary carries the command.
        summary: "ls",
        files: undefined,
      },
      { kind: "tool_result", callId: "c1", text: "ok", preview: "ok" },
    ],
  }));
});

test("file, pattern, and web call summaries name what they acted on", () => {
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [
      toolPart("r1", "read", { path: "/repo/FEATURE-MAP.md" }),
      toolPart("r2", "edit", { path: "/repo/a.ts", oldString: "x", newString: "y" }),
      toolPart("r3", "glob", { pattern: "**/TerminalTile*" }),
      toolPart("r4", "grep", { pattern: "scroll", path: "/repo" }),
      toolPart("r5", "webfetch", { url: "https://example.com/docs" }),
    ], 300),
  ]);
  const summaries = projection.page(0, 10)[0]!.blocks
    .filter((block) => block.kind === "tool_use")
    .map((block) => (block as { summary?: string }).summary);
  expect(summaries).toEqual([
    "read FEATURE-MAP.md",
    "edit a.ts",
    "**/TerminalTile*",
    'pattern "scroll"',
    "webfetch https://example.com/docs",
  ]);
});

type AssistantToolPart = Extract<
  Extract<SessionMessage, { type: "assistant" }>["content"][number],
  { type: "tool" }
>;

function toolPart(id: string, name: string, input: Record<string, unknown>): AssistantToolPart {
  return {
    type: "tool",
    id,
    name,
    state: { status: "completed", input, content: [{ type: "text", text: "ok" }], structured: {} },
    time: { created: 1, ran: 2, completed: 3 },
  };
}

test("a shell call without a command falls back to the tool name", () => {
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [
      {
        type: "tool",
        id: "c1",
        name: "shell",
        state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }], structured: {} },
        time: { created: 1, ran: 2, completed: 3 },
      },
    ], 300),
  ]);
  const call = projection.page(0, 10)[0]!.blocks[0]!;
  expect(call.kind).toBe("tool_use");
  if (call.kind === "tool_use") expect(call.summary).toBe("shell");
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

test("a running compaction draws no banner but keeps the turn open", () => {
  // The serve inserts the checkpoint when compaction STARTS: a banner for it would read
  // "context compacted" minutes before anything compacted, while the summary streams beside
  // the thread through the compaction watch instead.
  const projection = new LiveAgentProjection();
  const running = {
    id: "msg-c",
    type: "compaction",
    status: "running",
    reason: "auto",
    summary: "## Summary so far",
    recent: "recent context",
    time: { created: 400 },
  } as unknown as SessionMessage;
  const result = new OpencodeEventMapper(projection).sync([user("msg-u", "hi"), running]);
  expect(result.open).toBe(true);
  expect(result.lastTurnClosed).toBe(false);
  expect(projection.page(0, 10).map((row) => row.id)).toEqual(["opencode:msg-u"]);
});

test("a completed compaction with an explicit status still earns its banner", () => {
  const projection = new LiveAgentProjection();
  const compaction = {
    id: "msg-c",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "## Summary",
    recent: "recent context",
    time: { created: 400 },
  } as unknown as SessionMessage;
  new OpencodeEventMapper(projection).sync([compaction]);
  const rows = projection.page(0, 10);
  expect(rows.map((row) => row.id)).toEqual(["opencode:msg-c"]);
  expect(rows[0]!.blocks).toEqual([expect.objectContaining({ kind: "compaction", text: "## Summary" })]);
});

test("a cancelled compaction draws nothing; a failed one names its error", () => {
  const aborted = {
    id: "msg-x",
    type: "compaction",
    status: "failed",
    reason: "auto",
    error: { type: "aborted", message: "cancelled" },
    time: { created: 400 },
  } as unknown as SessionMessage;
  const failed = {
    id: "msg-f",
    type: "compaction",
    status: "failed",
    reason: "auto",
    error: { type: "compaction.failed", message: "no summary" },
    time: { created: 500 },
  } as unknown as SessionMessage;
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([aborted, failed]);
  const rows = projection.page(0, 10);
  // No banner claiming the context compacted: the failure reads as what it is.
  expect(rows.map((row) => row.id)).toEqual(["opencode:msg-f"]);
  expect(rows[0]!.blocks).toEqual([{ kind: "text", text: "Compaction failed: no summary" }]);
});

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageToolPart(id: string, uri: string, mime = "image/png"): AssistantToolPart {
  return {
    type: "tool",
    id,
    name: "read",
    state: {
      status: "completed",
      input: { path: "/tmp/shot.png" },
      content: [{ type: "text", text: "Image read successfully" }, { type: "file", uri, mime }],
      structured: {},
    },
    time: { created: 1, ran: 2, completed: 3 },
  };
}

test("a picture a call returned is drawn, not named", () => {
  const projection = new LiveAgentProjection();
  const result = new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [imageToolPart("c1", PNG_DATA_URL)], 300),
  ]);
  const blocks = projection.page(0, 10)[0]!.blocks;
  expect(blocks).toEqual([
    expect.objectContaining({ kind: "tool_use", tool: "read", callId: "c1" }),
    expect.objectContaining({ kind: "tool_result", callId: "c1", preview: "Image read successfully" }),
    // The image block carries the call's id, which is how the panel pairs it with its result.
    { kind: "image", mediaType: "image/png", callId: "c1" },
  ]);
  // ... and the bytes wait in the payload for the image route's store, in block order.
  expect(result.images).toEqual([
    { eventId: "opencode:msg-a", ordinal: 0, mediaType: "image/png", data: expect.any(String) },
  ]);
  expect(result.images[0]!.data.startsWith("iVBOR")).toBe(true);
});

test("a non-picture file keeps its placeholder line", () => {
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [imageToolPart("c1", PNG_DATA_URL.replace("image/png", "application/pdf"), "application/pdf")], 300),
  ]);
  const blocks = projection.page(0, 10)[0]!.blocks;
  expect(blocks.some((block) => block.kind === "image")).toBe(false);
  const resultBlock = blocks.find((block) => block.kind === "tool_result");
  expect(resultBlock).toEqual(expect.objectContaining({ preview: expect.stringContaining("[application/pdf]") }));
});

test("a file:// URI names bytes this sync cannot read, so it stays text", () => {
  const projection = new LiveAgentProjection();
  const result = new OpencodeEventMapper(projection).sync([
    assistant("msg-a", [imageToolPart("c1", "file:///tmp/shot.png")], 300),
  ]);
  const blocks = projection.page(0, 10)[0]!.blocks;
  expect(blocks.some((block) => block.kind === "image")).toBe(false);
  expect(result.images).toEqual([]);
});

test("a picture attached to a user message draws as its own block", () => {
  const projection = new LiveAgentProjection();
  const attached = {
    id: "msg-u",
    time: { created: 100 },
    text: "what about this",
    type: "user",
    files: [{ name: "shot.png", mime: "image/png", data: "aVZCT1I=" }],
  } as unknown as SessionMessage;
  const result = new OpencodeEventMapper(projection).sync([attached]);
  expect(projection.page(0, 10)[0]!.blocks).toEqual([
    { kind: "text", text: "what about this" },
    { kind: "image", mediaType: "image/png" },
  ]);
  expect(result.images).toEqual([
    { eventId: "opencode:msg-u", ordinal: 0, mediaType: "image/png", data: "aVZCT1I=" },
  ]);
});
