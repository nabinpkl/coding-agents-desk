import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { findClaudeSessionFiles, scanClaudeSession, UNKNOWN_MODEL } from "./claudeUsage.ts";

const NOON = "2026-08-13T06:30:00.000Z";

function assistant(options: {
  id: string;
  at?: string;
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  thinking?: number;
}) {
  return {
    type: "assistant",
    timestamp: options.at ?? NOON,
    isSidechain: false,
    message: {
      id: options.id,
      model: options.model ?? "claude-opus-5",
      usage: {
        input_tokens: options.input ?? 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: options.cacheCreation ?? 0,
        output_tokens: options.output ?? 0,
        output_tokens_details: { thinking_tokens: options.thinking ?? 0 },
      },
    },
  };
}

async function transcript(records: unknown[], name = "session.jsonl"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-usage-"));
  const path = join(root, name);
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
  return path;
}

test("input is the three fields added, and cached is the read alone", async () => {
  // The highest-risk arithmetic in the feature, and the opposite of Codex's. Claude's
  // `input_tokens` excludes both cache fields, so all three are summed -- and cache CREATION is
  // input processed fresh and written to the cache, so folding it into "cached" would report the
  // most expensive tokens in the record as the cheapest.
  const path = await transcript([
    assistant({ id: "msg_a", input: 2, cacheRead: 32_234, cacheCreation: 22_957, output: 231 }),
  ]);
  expect(await scanClaudeSession(path)).toEqual([
    ["a", "2026-08-13", "claude-opus-5", 55_193, 32_234, 231, 0],
  ]);
});

test("one response split across several lines is one request, not three", async () => {
  // Measured on real records: a response with a `thinking` block and two `tool_use` blocks is
  // written as three lines, each repeating the SAME `message.usage`. 124,127 such duplicate
  // occurrences on this machine, 32.96 billion input tokens.
  const shared = { id: "msg_a", input: 2, cacheRead: 30_123, cacheCreation: 49_934, output: 490 };
  const rows = await scanClaudeSession(await transcript([
    assistant({ ...shared, at: "2026-08-13T06:30:45.512Z" }),
    assistant({ ...shared, at: "2026-08-13T06:30:45.536Z" }),
    assistant({ ...shared, at: "2026-08-13T06:30:45.577Z" }),
  ]));
  expect(rows).toHaveLength(1);
  expect(rows[0]![3]).toBe(80_059);
});

test("a subagent's own request counts, because it was separately paid for", async () => {
  // Sidechain entries are real spend. What stops them being counted twice is the dedup above and
  // the one in the report, not an exclusion here.
  const rows = await scanClaudeSession(await transcript([
    { ...assistant({ id: "msg_a", input: 10 }), isSidechain: true },
    assistant({ id: "msg_b", input: 20 }),
  ]));
  expect(rows.map((row) => row[3])).toEqual([10, 20]);
});

test("a harness-injected line is not a request", async () => {
  // `<synthetic>` is stamped on lines the CLI wrote itself. No API call happened, so counting one
  // would inflate the request count with turns nobody was billed for.
  expect(await scanClaudeSession(await transcript([
    assistant({ id: "msg_a", model: "<synthetic>", input: 0 }),
    assistant({ id: "msg_b", input: 5 }),
  ]))).toHaveLength(1);
});

test("reasoning is the thinking portion of output, and defaults to zero", async () => {
  const rows = await scanClaudeSession(await transcript([
    assistant({ id: "msg_a", output: 900, thinking: 400 }),
    { type: "assistant", timestamp: NOON, message: { id: "msg_b", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2 } } },
  ]));
  expect(rows.map((row) => [row[5], row[6]])).toEqual([[900, 400], [2, 0]]);
});

test("a variant suffix does not split one model into two rows", async () => {
  const rows = await scanClaudeSession(await transcript([
    assistant({ id: "msg_a", model: "claude-opus-5" }),
    assistant({ id: "msg_b", model: "claude-opus-5[1m]" }),
  ]));
  expect(new Set(rows.map((row) => row[2]))).toEqual(new Set(["claude-opus-5"]));
});

test("a line with no model is attributed honestly rather than guessed", async () => {
  const rows = await scanClaudeSession(await transcript([
    { type: "assistant", timestamp: NOON, message: { id: "msg_a", usage: { input_tokens: 7 } } },
  ]));
  expect(rows[0]![2]).toBe(UNKNOWN_MODEL);
});

test("a half-written tail costs that line and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-usage-tail-"));
  const path = join(root, "session.jsonl");
  await writeFile(
    path,
    `${JSON.stringify(assistant({ id: "msg_a", input: 5 }))}\n{"type":"assistant","message":{"id":"msg_b","usage":{"input_tokens":`,
    "utf8",
  );
  expect(await scanClaudeSession(path)).toHaveLength(1);
});

test("a request that spans midnight lands on the day it happened", async () => {
  // Rows carry their own local day, so a session running past midnight contributes to two dates
  // rather than piling onto whichever one the file is filed under.
  const rows = await scanClaudeSession(await transcript([
    assistant({ id: "msg_a", at: new Date("2026-08-13T23:30:00").toISOString() }),
    assistant({ id: "msg_b", at: new Date("2026-08-14T00:30:00").toISOString() }),
  ]));
  expect(rows.map((row) => row[1])).toEqual(["2026-08-13", "2026-08-14"]);
});

test("subagent transcripts are found alongside their session's", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-find-"));
  const slug = join(root, "-Users-dev-projects-agent-desk");
  await mkdir(slug, { recursive: true });
  for (const name of ["a1b2.jsonl", "agent-abc123.jsonl", "journal.txt"]) {
    await writeFile(join(slug, name), "", "utf8");
  }
  expect((await findClaudeSessionFiles(root)).map((path) => path.slice(slug.length + 1)))
    .toEqual(["a1b2.jsonl", "agent-abc123.jsonl"]);
});
