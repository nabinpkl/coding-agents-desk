import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { findCodexSessionFiles, scanCodexSession, UNKNOWN_MODEL } from "@/usage/codexUsage";
import { localDayKey } from "@/usage/usageTotals";

async function rollout(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-"));
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

function tokenCount(timestamp: string, usage: Record<string, number>, rateLimits?: unknown) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: usage, total_token_usage: { total_tokens: 0 } },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
    },
  };
}

function turnContext(model: string) {
  return { timestamp: "2026-08-13T04:00:00.000Z", type: "turn_context", payload: { model } };
}

test("input is stored as published, with the cached part as a subset of it", async () => {
  // The whole feature turns on this. Codex's `input_tokens` ALREADY INCLUDES
  // `cached_input_tokens`, so 39,495 total with 6,912 cached is 32,583 of uncached input, not
  // 46,407 of it. Adding the two is the mistake that inflates a day by up to 98% while still
  // producing a number that looks reasonable.
  const path = await rollout([
    turnContext("gpt-5.6-sol"),
    tokenCount("2026-08-13T04:10:00.000Z", {
      input_tokens: 39_495,
      cached_input_tokens: 6_912,
      output_tokens: 25,
      reasoning_output_tokens: 4,
    }),
  ]);

  const scanned = await scanCodexSession(path);
  const day = localDayKey(Date.parse("2026-08-13T04:10:00.000Z"));
  expect(scanned.days[day]!["gpt-5.6-sol"]).toEqual([39_495, 6_912, 25, 4, 1]);
});

test("per-request usage is summed, because it is a delta and not a running total", async () => {
  // Real records: 39,520 then 39,747, reaching a published cumulative of 79,267. Summing
  // `last_token_usage` reproduces the cumulative exactly, which is what makes per-day
  // attribution possible at all.
  const path = await rollout([
    turnContext("gpt-5.6-sol"),
    tokenCount("2026-08-13T04:10:00.000Z", { input_tokens: 39_495, cached_input_tokens: 6_912, output_tokens: 25 }),
    tokenCount("2026-08-13T04:11:00.000Z", { input_tokens: 39_743, cached_input_tokens: 38_656, output_tokens: 4 }),
  ]);

  const scanned = await scanCodexSession(path);
  const day = localDayKey(Date.parse("2026-08-13T04:10:00.000Z"));
  const totals = scanned.days[day]!["gpt-5.6-sol"]!;
  expect(totals[0] + totals[2]).toBe(79_267);
  expect(totals[4]).toBe(2);
});

test("a session running past midnight lands on both days", async () => {
  // Local midnight, whatever this machine's zone is: the day keys are built from local parts, so
  // the test computes its own boundary rather than assuming UTC.
  const beforeMs = Date.parse("2026-08-13T12:00:00.000Z");
  const before = new Date(beforeMs);
  const midnight = new Date(before.getFullYear(), before.getMonth(), before.getDate() + 1, 0, 30);
  const path = await rollout([
    turnContext("gpt-5.6-sol"),
    tokenCount(before.toISOString(), { input_tokens: 100, cached_input_tokens: 10, output_tokens: 1 }),
    tokenCount(midnight.toISOString(), { input_tokens: 200, cached_input_tokens: 20, output_tokens: 2 }),
  ]);

  const scanned = await scanCodexSession(path);
  expect(Object.keys(scanned.days).sort()).toEqual([localDayKey(beforeMs), localDayKey(midnight.getTime())]);
});

test("usage is attributed to the model the transcript last named", async () => {
  const path = await rollout([
    tokenCount("2026-08-13T04:00:00.000Z", { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }),
    turnContext("gpt-5.6-sol"),
    tokenCount("2026-08-13T04:10:00.000Z", { input_tokens: 20, cached_input_tokens: 0, output_tokens: 2 }),
    turnContext("gpt-5.6-luna"),
    tokenCount("2026-08-13T04:20:00.000Z", { input_tokens: 30, cached_input_tokens: 0, output_tokens: 3 }),
  ]);

  const scanned = await scanCodexSession(path);
  const day = localDayKey(Date.parse("2026-08-13T04:00:00.000Z"));
  // The first record predates any `turn_context`. Named rather than guessed: attributing it to
  // whichever model came next would put one session's tokens on a model that had not run yet.
  expect(Object.keys(scanned.days[day]!).sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", UNKNOWN_MODEL]);
  expect(scanned.days[day]![UNKNOWN_MODEL]![0]).toBe(10);
  expect(scanned.days[day]!["gpt-5.6-luna"]![0]).toBe(30);
});

test("the newest rate limit in the file wins, and its reset is milliseconds", async () => {
  const limits = (percent: number, resetsAt: number) => ({
    plan_type: "prolite",
    primary: { used_percent: percent, window_minutes: 10_080, resets_at: resetsAt },
  });
  const path = await rollout([
    tokenCount("2026-08-13T04:00:00.000Z", { input_tokens: 1 }, limits(58, 1_787_196_784)),
    tokenCount("2026-08-13T05:00:00.000Z", { input_tokens: 1 }, limits(12, 1_787_801_862)),
  ]);

  const scanned = await scanCodexSession(path);
  expect(scanned.quota).toEqual({
    atMs: Date.parse("2026-08-13T05:00:00.000Z"),
    usedPercent: 12,
    windowMinutes: 10_080,
    // Codex publishes epoch SECONDS; everything else in this codebase is milliseconds.
    resetsAtMs: 1_787_801_862_000,
    planType: "prolite",
  });
});

test("a half-written record is skipped and the rest of the file is still summed", async () => {
  // A session being appended to right now ends mid-line as often as not.
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-"));
  const path = join(directory, "rollout.jsonl");
  await writeFile(
    path,
    [
      JSON.stringify(turnContext("gpt-5.6-sol")),
      JSON.stringify(tokenCount("2026-08-13T04:10:00.000Z", { input_tokens: 100, cached_input_tokens: 10 })),
      '{"timestamp":"2026-08-13T04:11:00.000Z","payload":{"type":"token_count","info":{"last_to',
    ].join("\n"),
    "utf8",
  );

  const scanned = await scanCodexSession(path);
  const day = localDayKey(Date.parse("2026-08-13T04:10:00.000Z"));
  expect(scanned.days[day]!["gpt-5.6-sol"]).toEqual([100, 10, 0, 0, 1]);
});

test("a record with no usable timestamp contributes to no day", async () => {
  const path = await rollout([
    turnContext("gpt-5.6-sol"),
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5 } } } },
  ]);
  expect(await scanCodexSession(path)).toEqual({ days: {}, quota: null });
});

test("archived rollouts are counted alongside live ones", async () => {
  // Archiving a thread moves its file to a flat directory. The usage still happened.
  const home = await mkdtemp(join(tmpdir(), "codex-home-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, "sessions", "2026", "08", "13"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "2026", "08", "13", "a.jsonl"), "", "utf8");
  await writeFile(join(home, "archived_sessions", "b.jsonl"), "", "utf8");
  await writeFile(join(home, "sessions", "notes.txt"), "", "utf8");

  const files = await findCodexSessionFiles(home);
  expect(files.map((path) => path.slice(home.length))).toEqual([
    "/archived_sessions/b.jsonl",
    "/sessions/2026/08/13/a.jsonl",
  ]);
});
