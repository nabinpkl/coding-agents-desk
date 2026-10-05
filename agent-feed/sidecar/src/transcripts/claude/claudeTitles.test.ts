// A transcript's title is its LAST custom-title record, even when the catalog's two windows
// cannot see it: a long run of tool output between two title records is the ordinary case.
import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeader } from "@/transcripts/claude/claudeProjects";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function transcript(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-claude-titles-"));
  directories.push(directory);
  return join(directory, "session.jsonl");
}

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const opening = line({ type: "user", cwd: "/projects/x", message: { role: "user", content: "hi" } });
const custom = (title: string) => line({ type: "custom-title", customTitle: title, sessionId: "s" });
const ai = (title: string) => line({ type: "ai-title", aiTitle: title, sessionId: "s" });
/** Untitled output, the shape a long tool result takes: far more than one 32 KB window. */
const output = (kilobytes: number) =>
  Array.from({ length: kilobytes }, () => line({ type: "assistant", text: "x".repeat(1000) })).join("");

test("a tail with no title reports the latest one, not the head's", async () => {
  const path = await transcript();
  await writeFile(path, opening + custom("First") + output(40) + custom("Second") + output(200));
  expect((await readHeader(path))?.title).toBe("Second");
});

test("a title appended past the tail window's reach is still the answer on the next read", async () => {
  const path = await transcript();
  await writeFile(path, opening + custom("First") + output(80));
  expect((await readHeader(path))?.title).toBe("First");
  // More than a window of output after the new title, between two reads.
  await appendFile(path, custom("Second") + output(100));
  expect((await readHeader(path))?.title).toBe("Second");
  await appendFile(path, output(50));
  expect((await readHeader(path))?.title).toBe("Second");
});

test("a file that shrank is read again rather than trusted", async () => {
  const path = await transcript();
  await writeFile(path, opening + custom("Long") + output(100) + custom("Later") + output(100));
  expect((await readHeader(path))?.title).toBe("Later");
  await writeFile(path, opening + custom("Short") + output(100));
  expect((await readHeader(path))?.title).toBe("Short");
});

test("a generated title never outranks a chosen one, wherever each sits", async () => {
  const path = await transcript();
  await writeFile(path, opening + custom("Chosen") + output(100) + ai("Generated") + output(10));
  expect((await readHeader(path))?.title).toBe("Chosen");
});
