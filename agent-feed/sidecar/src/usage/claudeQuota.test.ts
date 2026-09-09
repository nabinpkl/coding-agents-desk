import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readClaudeQuota } from "./claudeQuota.ts";

async function configWith(body: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "claude-quota-")), "config.json");
  await writeFile(path, JSON.stringify(body), "utf8");
  return path;
}

function utilization(fiveHour: number | null, sevenDay: number | null) {
  return {
    cachedUsageUtilization: {
      fetchedAtMs: 1_788_687_158_244,
      utilization: {
        five_hour: fiveHour === null
          ? null
          : { utilization: fiveHour, resets_at: "2026-09-06T10:30:00.277564+00:00" },
        seven_day: sevenDay === null
          ? null
          : { utilization: sevenDay, resets_at: "2026-09-06T16:00:00.277580+00:00" },
        seven_day_opus: null,
      },
    },
  };
}

test("the window closest to its limit is the one reported", async () => {
  // One row, two windows. Either can be the one that stops you, so the most-used wins rather
  // than the shortest.
  const sample = await readClaudeQuota(await configWith(utilization(12, 74)));
  expect(sample?.usedPercent).toBe(74);
  expect(sample?.windowMinutes).toBe(7 * 24 * 60);
});

test("the reading carries when it was taken, not when it was read", async () => {
  // The field is a cache the CLI refreshes on its own schedule, measured 45 hours stale on the
  // machine this was written against. Without the stamp the panel would show that as current.
  const sample = await readClaudeQuota(await configWith(utilization(92, 36)));
  expect(sample).toEqual({
    atMs: 1_788_687_158_244,
    usedPercent: 92,
    windowMinutes: 300,
    resetsAtMs: Date.parse("2026-09-06T10:30:00.277564+00:00"),
    planType: null,
  });
});

test("a config with no utilization gives null, never a zero", async () => {
  // A zero would render as a full meter with plenty left, which is a claim. Null renders as no
  // meter, which is the truth.
  expect(await readClaudeQuota(await configWith({}))).toBeNull();
  expect(await readClaudeQuota(await configWith(utilization(null, null)))).toBeNull();
  expect(await readClaudeQuota(join(tmpdir(), "does-not-exist-claude.json"))).toBeNull();
});

test("a config being rewritten under us is not an error", async () => {
  const path = await configWith({});
  await writeFile(path, '{"cachedUsageUtilization":{"fetchedAtMs":1,"utiliz', "utf8");
  expect(await readClaudeQuota(path)).toBeNull();
});
