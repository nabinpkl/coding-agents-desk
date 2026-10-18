import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTaskState, taskStateOfLine } from "@/transcripts/claude/claudeTaskState";

const work = mkdtempSync(join(tmpdir(), "claude-task-state-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function said(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-17T09:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });
}

const block = (task: string) => `<task-state>\ntask: ${task}\n- one decision\n</task-state>\n\nStarting.`;

async function read(path: string) {
  const fh = await open(path, "r");
  try {
    return await currentTaskState(fh, path, statSync(path).size);
  } finally {
    await fh.close();
  }
}

describe("whose block counts", () => {
  test("the session's own text, not a person's message, a tool result or a subagent", () => {
    expect(taskStateOfLine(said(block("mine")))?.task).toBe("mine");
    expect(taskStateOfLine(said(block("sub"), { isSidechain: true }))).toBeNull();
    expect(taskStateOfLine(JSON.stringify({ type: "user", message: { content: block("quoted") } }))).toBeNull();
    expect(
      taskStateOfLine(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", content: [{ type: "text", text: block("tool") }] }] },
        }),
      ),
    ).toBeNull();
  });
});

describe("the newest block in a transcript", () => {
  test("is found, and replaced by one appended later without rereading the file", async () => {
    const path = join(work, "a.jsonl");
    writeFileSync(path, `${said(block("first"))}\n${said("no block here")}\n`);
    expect((await read(path))?.task).toBe("first");
    appendFileSync(path, `${said("still the first")}\n`);
    expect((await read(path))?.task).toBe("first");
    appendFileSync(path, `${said(block("second"))}\n`);
    expect((await read(path))?.task).toBe("second");
  });

  test("is absent from a transcript that never wrote one", async () => {
    const path = join(work, "b.jsonl");
    writeFileSync(path, `${said("hello")}\n`);
    expect(await read(path)).toBeUndefined();
  });
});
