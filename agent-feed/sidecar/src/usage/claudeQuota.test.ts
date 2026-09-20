import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readClaudeQuotas } from "@/usage/claudeQuota";

const FIVE_HOUR_RESET = 1_788_700_000;
const SEVEN_DAY_RESET = 1_789_200_000;

async function files(config: unknown, mirror: unknown): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const configPath = join(root, "config.json");
  const mirrorPath = join(root, "mirror.json");
  if (config !== undefined) await writeFile(configPath, JSON.stringify(config), "utf8");
  if (mirror !== undefined) await writeFile(mirrorPath, JSON.stringify(mirror), "utf8");
  return [configPath, mirrorPath];
}

/**
 * The CLI's config cache, in the units the CLI itself uses: `utilization` is a FRACTION and
 * `resets_at` is epoch SECONDS. Both are pinned by the binary -- the header parser clamps
 * utilization with `Math.max(0, Math.min(1, s))` and the near-limit hint tests
 * `resets_at * 1000 > Date.now()`.
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

/** The statusline mirror, which carries the percentage already multiplied out. */
function mirror(fiveHour: number, sevenDay: number, fetchedAtMs: number) {
  return {
    fetchedAtMs,
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: FIVE_HOUR_RESET },
      seven_day: { used_percentage: sevenDay, resets_at: SEVEN_DAY_RESET },
    },
  };
}

test("every window is reported, shortest first, rather than only the fullest", async () => {
  // One row per window, because the two do not substitute for one another: a heavy afternoon
  // runs the five-hour meter up while the weekly one is still low, and a reader deciding whether
  // to start something long needs both numbers rather than whichever is worse right now.
  const [configPath, mirrorPath] = await files(config(0.12, 0.74), undefined);

  expect(await readClaudeQuotas(configPath, mirrorPath)).toEqual([
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
  const [configPath, mirrorPath] = await files(config(0.92, 0.36), undefined);
  const quotas = await readClaudeQuotas(configPath, mirrorPath);

  expect(quotas.map((quota) => quota.usedPercent)).toEqual([92, 36]);
});

test("a reset in epoch seconds becomes milliseconds, and an ISO one still parses", async () => {
  // Epoch seconds is what both files carry today. The ISO branch is for a config written by an
  // older CLI, which is the only shape this code has ever been tested against before.
  const iso = "2026-09-06T10:30:00.277564+00:00";
  const [configPath, mirrorPath] = await files(
    { cachedUsageUtilization: { fetchedAtMs: 1, utilization: { five_hour: { utilization: 0.1, resets_at: iso } } } },
    undefined,
  );

  expect((await readClaudeQuotas(configPath, mirrorPath))[0]?.resetsAtMs).toBe(Date.parse(iso));
});

test("the newer of the two sources wins whole, rather than being merged window by window", async () => {
  // Merging would put two readings taken hours apart under one age, and the age is the only
  // thing that tells a reader whether to believe the number.
  const [configPath, mirrorPath] = await files(
    config(0.92, 0.36, 1_788_000_000_000),
    mirror(4, 11, 1_789_000_000_000),
  );

  const quotas = await readClaudeQuotas(configPath, mirrorPath);
  expect(quotas.map((quota) => quota.usedPercent)).toEqual([4, 11]);
  expect(quotas.every((quota) => quota.atMs === 1_789_000_000_000)).toBe(true);
});

test("a stale mirror loses to a fresher config", async () => {
  const [configPath, mirrorPath] = await files(
    config(0.5, 0.6, 1_789_000_000_000),
    mirror(4, 11, 1_788_000_000_000),
  );

  expect((await readClaudeQuotas(configPath, mirrorPath)).map((quota) => quota.usedPercent))
    .toEqual([50, 60]);
});

test("the mirror alone is enough, which is the machine this was written on", async () => {
  // `cachedUsageUtilization` was absent from `~/.claude.json` entirely on 2026-09-15 (CLI
  // 2.1.273) and from every rotated backup of it, while sessions ran all day. A meter that
  // needed that field would have shown nothing on the machine that asked for it.
  const [configPath, mirrorPath] = await files(undefined, mirror(7, 21, 1_789_000_000_000));

  expect((await readClaudeQuotas(configPath, mirrorPath)).map((quota) => quota.usedPercent))
    .toEqual([7, 21]);
});

test("a window scoped to one model is named, so two weekly rows are told apart", async () => {
  const [configPath, mirrorPath] = await files(undefined, {
    fetchedAtMs: 5,
    rate_limits: {
      seven_day: { used_percentage: 30, resets_at: SEVEN_DAY_RESET },
      seven_day_opus: { used_percentage: 80, resets_at: SEVEN_DAY_RESET },
    },
  });

  expect((await readClaudeQuotas(configPath, mirrorPath)).map((quota) => quota.scope))
    .toEqual([null, "Opus"]);
});

test("no readable source gives an empty list, never a zero", async () => {
  // A zero would render as a full meter with plenty left, which is a claim. Nothing renders as
  // no meter, which is the truth.
  const [configPath, mirrorPath] = await files({}, undefined);

  expect(await readClaudeQuotas(configPath, mirrorPath)).toEqual([]);
  expect(await readClaudeQuotas(join(tmpdir(), "nope.json"), join(tmpdir(), "nope2.json")))
    .toEqual([]);
});

test("a file being rewritten under us is not an error", async () => {
  const [configPath, mirrorPath] = await files({}, undefined);
  await writeFile(configPath, '{"cachedUsageUtilization":{"fetchedAtMs":1,"util', "utf8");

  expect(await readClaudeQuotas(configPath, mirrorPath)).toEqual([]);
});
