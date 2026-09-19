import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readClaudeQuotas } from "@/usage/claudeQuota";

const FIVE_HOUR_RESET = 1_788_700_000;
const SEVEN_DAY_RESET = 1_789_200_000;

async function configWith(body: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "claude-quota-")), "config.json");
  if (body !== undefined) await writeFile(path, JSON.stringify(body), "utf8");
  return path;
}

/**
 * The CLI's config cache, in the CLI's own units: `utilization` is a FRACTION and `resets_at` is
 * epoch SECONDS. Both are pinned by its binary -- the header parser clamps utilization with
 * `Math.max(0, Math.min(1, s))` and the near-limit hint tests `resets_at * 1000 > Date.now()`.
 */
function config(fiveHour: number | null, sevenDay: number | null, fetchedAtMs = 1_788_687_158_244) {
  return {
    cachedUsageUtilization: {
      fetchedAtMs,
      utilization: {
        five_hour: fiveHour === null ? null : { utilization: fiveHour, resets_at: FIVE_HOUR_RESET },
        seven_day: sevenDay === null ? null : { utilization: sevenDay, resets_at: SEVEN_DAY_RESET },
        seven_day_opus: null,
      },
    },
  };
}

test("every window is reported, shortest first, rather than only the fullest", async () => {
  // One row per window, because the two do not substitute for one another: a heavy afternoon runs
  // the five-hour meter up while the weekly one is still low, and a reader deciding whether to
  // start something long needs both numbers rather than whichever is worse right now.
  expect(await readClaudeQuotas(await configWith(config(0.12, 0.74)))).toEqual([
    {
      atMs: 1_788_687_158_244,
      usedPercent: 12,
      windowMinutes: 300,
      resetsAtMs: FIVE_HOUR_RESET * 1000,
      planType: null,
      scope: null,
    },
    {
      atMs: 1_788_687_158_244,
      usedPercent: 74,
      windowMinutes: 7 * 24 * 60,
      resetsAtMs: SEVEN_DAY_RESET * 1000,
      planType: null,
      scope: null,
    },
  ]);
});

test("the CLI's utilization is a fraction, so it is multiplied out rather than passed through", async () => {
  // The trap this pins: read as a percent, a window at 92% renders as 1% and a reader takes a
  // nearly-spent window for an empty one.
  const quotas = await readClaudeQuotas(await configWith(config(0.92, 0.36)));

  expect(quotas.map((quota) => quota.usedPercent)).toEqual([92, 36]);
});

test("a reset in epoch seconds becomes milliseconds, and an ISO one still parses", async () => {
  // Epoch seconds is what the file carries today. The ISO branch is for a config written by an
  // older CLI, which is the only shape this code was ever tested against before.
  const iso = "2026-09-06T10:30:00.277564+00:00";
  const path = await configWith({
    cachedUsageUtilization: {
      fetchedAtMs: 1,
      utilization: { five_hour: { utilization: 0.1, resets_at: iso } },
    },
  });

  expect((await readClaudeQuotas(path))[0]?.resetsAtMs).toBe(Date.parse(iso));
});

test("a window scoped to one model is named, so two weekly rows are told apart", async () => {
  const path = await configWith({
    cachedUsageUtilization: {
      fetchedAtMs: 5,
      utilization: {
        seven_day: { utilization: 0.3, resets_at: SEVEN_DAY_RESET },
        seven_day_opus: { utilization: 0.8, resets_at: SEVEN_DAY_RESET },
      },
    },
  });

  expect((await readClaudeQuotas(path)).map((quota) => quota.scope)).toEqual([null, "Opus"]);
});

test("an absent or empty config gives an empty list, never a zero", async () => {
  // A zero would render as a full meter with plenty left, which is a claim. Nothing renders as no
  // meter, which is the truth -- and absent is the normal state of this file: measured 2026-09-15,
  // `cachedUsageUtilization` was missing from `~/.claude.json` and from every rotated backup while
  // sessions ran all day. That is why the live reading is the source and this is the fallback.
  expect(await readClaudeQuotas(await configWith({}))).toEqual([]);
  expect(await readClaudeQuotas(await configWith(config(null, null)))).toEqual([]);
  expect(await readClaudeQuotas(join(tmpdir(), "does-not-exist-claude.json"))).toEqual([]);
});

test("a config being rewritten under us is not an error", async () => {
  const path = await configWith({});
  await writeFile(path, '{"cachedUsageUtilization":{"fetchedAtMs":1,"util', "utf8");

  expect(await readClaudeQuotas(path)).toEqual([]);
});
