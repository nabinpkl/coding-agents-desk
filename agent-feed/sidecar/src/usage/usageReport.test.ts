import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadUsageCache } from "@/usage/usageCache";
import { createUsageScanner, detectUsageVendors } from "@/usage/usageReport";

interface Fixture {
  codexHome: string;
  // Pointed at nothing on purpose. Both vendors are swept on every scan, so a fixture that let
  // these fall back to the config defaults would read the developer's own 2.6 GB of transcripts
  // into a unit test and make its assertions depend on the machine it ran on.
  claudeProjects: string;
  claudeConfig: string;
  cachePath: string;
  write: (name: string, records: unknown[]) => Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "usage-report-"));
  const home = join(root, "codex");
  const day = join(home, "sessions", "2026", "08", "13");
  await mkdir(day, { recursive: true });
  return {
    codexHome: home,
    claudeProjects: join(root, "no-claude"),
    claudeConfig: join(root, "no-claude.json"),
    cachePath: join(root, "cache.json"),
    write: async (name, records) => {
      const path = join(day, name);
      await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
      return path;
    },
  };
}

function usage(timestamp: string, input: number, cached: number, output = 0) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
  };
}

const NOON = "2026-08-13T06:30:00.000Z";
const model = { timestamp: NOON, type: "turn_context", payload: { model: "gpt-5.6-sol" } };

test("a vendor with no records reports itself uninstalled rather than empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-empty-"));
  const report = await createUsageScanner({
    codexHome: join(root, "nothing-here"),
    claudeProjects: join(root, "nothing-here"),
    claudeConfig: join(root, "nothing-here.json"),
    cachePath: join(root, "cache.json"),
  }).scan();

  const codex = report.vendors[0]!;
  expect(codex.installed).toBe(false);
  expect(codex.days).toEqual([]);
  // Two different facts, and the panel says different things about them: "Codex is not on this
  // machine" is not "Codex ran nothing".
  expect(codex.coverage.sessions).toBe(0);
  expect(detectUsageVendors({
    codexHome: join(root, "nothing-here"),
    claudeProjects: join(root, "nothing-here"),
  })).toEqual([]);
});

test("days carry a total and a per-model split, heaviest model first", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [
    model,
    usage(NOON, 100, 60, 5),
    { timestamp: NOON, type: "turn_context", payload: { model: "gpt-5.6-luna" } },
    usage(NOON, 900, 400, 9),
  ]);

  const report = await createUsageScanner(context).scan();
  const day = report.vendors[0]!.days[0]!;
  expect(day.totals).toEqual({
    inputTokens: 1000,
    cachedInputTokens: 460,
    outputTokens: 14,
    reasoningTokens: 0,
    requests: 2,
  });
  expect(day.byModel.map((entry) => entry.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
});

test("two sessions on one day are summed, not overwritten", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  await context.write("b.jsonl", [model, usage(NOON, 200, 120)]);

  const report = await createUsageScanner(context).scan();
  expect(report.vendors[0]!.days[0]!.totals.inputTokens).toBe(300);
  expect(report.vendors[0]!.coverage.sessions).toBe(2);
});

test("an unchanged file is not re-read, and an unchanged sweep returns the same report", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  const scanner = createUsageScanner(context);

  const first = await scanner.scan();
  const second = await scanner.scan();
  // Identity, deliberately. The route decides whether to send a second message by comparing the
  // two, so "nothing changed" has to be observable without diffing 50 KB of JSON.
  expect(second).toBe(first);
});

test("a file that grew is re-summed and replaces its old contribution", async () => {
  const context = await fixture();
  const path = await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  const scanner = createUsageScanner(context);
  expect((await scanner.scan()).vendors[0]!.days[0]!.totals.inputTokens).toBe(100);

  await writeFile(
    path,
    [model, usage(NOON, 100, 60), usage(NOON, 50, 20)].map((r) => JSON.stringify(r)).join("\n"),
    "utf8",
  );
  const second = await scanner.scan();
  // 150, not 250: the file's whole contribution is replaced rather than added to. Getting this
  // wrong would make every day grow every time the panel was opened.
  expect(second.vendors[0]!.days[0]!.totals.inputTokens).toBe(150);
});

test("a file whose bytes did not move is trusted even when its contents did", async () => {
  // The cache's whole premise, stated as a test so its cost is visible: size and mtime decide.
  // Codex rollouts are append-only and stop changing when the session ends, so this is safe in
  // practice; a hand-edited file with a restored mtime is the case it cannot see.
  const context = await fixture();
  const path = await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  const scanner = createUsageScanner(context);
  await scanner.scan();

  const stamp = new Date("2026-08-13T07:00:00.000Z");
  await writeFile(path, [model, usage(NOON, 999, 60)].map((r) => JSON.stringify(r)).join("\n"), "utf8");
  await utimes(path, stamp, stamp);
  const before = await createUsageScanner(context).scan();
  await utimes(path, stamp, stamp);
  const after = await createUsageScanner(context).scan();
  expect(after.vendors[0]!.days[0]!.totals.inputTokens)
    .toBe(before.vendors[0]!.days[0]!.totals.inputTokens);
});

test("a deleted session stops counting and leaves the cache", async () => {
  const context = await fixture();
  const path = await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  await context.write("b.jsonl", [model, usage(NOON, 200, 120)]);
  const scanner = createUsageScanner(context);
  expect((await scanner.scan()).vendors[0]!.days[0]!.totals.inputTokens).toBe(300);

  await rm(path);
  const second = await scanner.scan();
  expect(second.vendors[0]!.days[0]!.totals.inputTokens).toBe(200);
  const cache = await loadUsageCache(context.cachePath);
  expect(Object.keys(cache.sessions)).toHaveLength(1);
});

test("the cache survives a new scanner, which is the point of writing it down", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  await createUsageScanner(context).scan();

  const cache = await loadUsageCache(context.cachePath);
  expect(Object.keys(cache.sessions)).toHaveLength(1);
  const rebuilt = await createUsageScanner(context).scan();
  expect(rebuilt.vendors[0]!.days[0]!.totals.inputTokens).toBe(100);
});

test("a cache from another timezone is discarded rather than mixed", async () => {
  // Day keys are LOCAL calendar days. A cache bucketed in another zone is not wrong-looking, it
  // is wrong-silently, so it is thrown away and rebuilt.
  const context = await fixture();
  await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  await createUsageScanner(context).scan();

  const raw = JSON.parse(await Bun.file(context.cachePath).text());
  await writeFile(context.cachePath, JSON.stringify({ ...raw, timezone: "Antarctica/Troll" }), "utf8");
  expect(Object.keys((await loadUsageCache(context.cachePath)).sessions)).toHaveLength(0);
});

test("a session file that cannot be read is counted, not ignored", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  const denied = await context.write("b.jsonl", [model, usage(NOON, 999, 0)]);
  await chmod(denied, 0o000);

  const report = await createUsageScanner(context).scan();
  // Surfaced on the report: a file skipped in silence is a total that is wrong without saying so.
  expect(report.vendors[0]!.coverage.unreadable).toBe(1);
  expect(report.vendors[0]!.days[0]!.totals.inputTokens).toBe(100);
});

test("the quota is the newest reading across every session", async () => {
  const context = await fixture();
  const limits = (percent: number, minutes: number) => ({
    plan_type: "prolite",
    primary: { used_percent: percent, window_minutes: minutes, resets_at: 1_787_801_862 },
  });
  await context.write("a.jsonl", [
    { ...usage("2026-08-13T04:00:00.000Z", 1, 0), payload: { ...usage("x", 1, 0).payload, rate_limits: limits(58, 10_080) } },
  ]);
  await context.write("b.jsonl", [
    { ...usage("2026-08-13T09:00:00.000Z", 1, 0), payload: { ...usage("x", 1, 0).payload, rate_limits: limits(12, 10_080) } },
  ]);

  const report = await createUsageScanner(context).scan();
  expect(report.vendors[0]!.quota).toEqual({
    label: "Weekly limit",
    usedPercent: 12,
    windowMinutes: 10_080,
    resetsAt: 1_787_801_862_000,
    planType: "prolite",
    sampledAt: Date.parse("2026-08-13T09:00:00.000Z"),
  });
});

test("a five-hour window is named for what it is", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [
    {
      timestamp: NOON,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 1 } },
        rate_limits: { plan_type: "free", primary: { used_percent: 4, window_minutes: 300, resets_at: 1 } },
      },
    },
  ]);
  expect((await createUsageScanner(context).scan()).vendors[0]!.quota?.label).toBe("5-hour limit");
});

test("concurrent readers share one sweep", async () => {
  const context = await fixture();
  await context.write("a.jsonl", [model, usage(NOON, 100, 60)]);
  const scanner = createUsageScanner(context);

  const [first, second] = await Promise.all([scanner.scan(), scanner.scan()]);
  expect(second).toBe(first);
});

test("nothing is cached before the first sweep", async () => {
  const context = await fixture();
  const scanner = createUsageScanner(context);
  expect(scanner.cached()).toBeNull();
  const report = await scanner.scan();
  expect(scanner.cached()).toBe(report);
});

interface ClaudeFixture {
  codexHome: string;
  claudeProjects: string;
  claudeConfig: string;
  cachePath: string;
  write: (name: string, records: unknown[]) => Promise<string>;
}

async function claudeFixture(): Promise<ClaudeFixture> {
  const root = await mkdtemp(join(tmpdir(), "usage-claude-"));
  const slug = join(root, "projects", "-Users-dev-projects-agent-desk");
  await mkdir(slug, { recursive: true });
  return {
    codexHome: join(root, "no-codex"),
    claudeProjects: join(root, "projects"),
    claudeConfig: join(root, "no-claude.json"),
    cachePath: join(root, "cache.json"),
    write: async (name, records) => {
      const path = join(slug, name);
      await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
      return path;
    },
  };
}

function claudeUsage(id: string, input: number, cacheRead = 0, at = NOON) {
  return {
    type: "assistant",
    timestamp: at,
    message: {
      id,
      model: "claude-opus-5",
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    },
  };
}

test("a forked session does not count its parent's requests a second time", async () => {
  // `claude --resume <id> --fork-session` copies the parent's history verbatim into a new file,
  // so both files carry the pre-fork requests. Measured on one real pair on this machine: 1.344
  // billion input tokens naively against 522 million deduped, a 61.2% overcount. Summing per
  // file and adding the sums would report a machine's whole history at 283% of its real size.
  const context = await claudeFixture();
  await context.write("parent.jsonl", [claudeUsage("msg_a", 100), claudeUsage("msg_b", 200)]);
  await context.write("fork.jsonl", [
    claudeUsage("msg_a", 100),
    claudeUsage("msg_b", 200),
    claudeUsage("msg_c", 400),
  ]);

  const report = await createUsageScanner(context).scan();
  const claude = report.vendors.find((vendor) => vendor.vendor === "claude")!;
  expect(claude.days[0]!.totals.inputTokens).toBe(700);
  expect(claude.days[0]!.totals.requests).toBe(3);
});

test("both vendors are reported, whether or not either is installed", async () => {
  // The modal's tabs are built from this list, so a vendor that is absent still has to appear --
  // as installed: false, which the panel says something different about than "ran nothing".
  const context = await claudeFixture();
  await context.write("a.jsonl", [claudeUsage("msg_a", 100)]);

  const report = await createUsageScanner(context).scan();
  expect(report.vendors.map((vendor) => vendor.vendor)).toEqual(["codex", "claude"]);
  expect(report.vendors[0]!.installed).toBe(false);
  expect(report.vendors[1]!.installed).toBe(true);
});

test("one vendor's sweep does not evict the other's cache entries", async () => {
  // Both vendors share one `sessions` map keyed by absolute path. An eviction that read the whole
  // map rather than its own root would have the Codex sweep delete every Claude entry as "gone",
  // and the Claude sweep behind it would re-read the lot to put them back -- on this machine,
  // 2.6 GB, every time the modal was opened.
  const context = await claudeFixture();
  await mkdir(join(context.codexHome, "sessions"), { recursive: true });
  await context.write("a.jsonl", [claudeUsage("msg_a", 100)]);

  await createUsageScanner(context).scan();
  const cache = await loadUsageCache(context.cachePath);
  expect(Object.keys(cache.sessions)).toHaveLength(1);
});

test("the Claude quota comes from the CLI's config, stamped with when it was taken", async () => {
  const context = await claudeFixture();
  await context.write("a.jsonl", [claudeUsage("msg_a", 100)]);
  await writeFile(context.claudeConfig, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 1_788_687_158_244,
      utilization: {
        five_hour: { utilization: 92, resets_at: "2026-09-06T10:30:00.000Z" },
        seven_day: { utilization: 36, resets_at: "2026-09-06T16:00:00.000Z" },
      },
    },
  }), "utf8");

  const report = await createUsageScanner(context).scan();
  expect(report.vendors[1]!.quota).toEqual({
    label: "5-hour limit",
    usedPercent: 92,
    windowMinutes: 300,
    resetsAt: Date.parse("2026-09-06T10:30:00.000Z"),
    planType: null,
    sampledAt: 1_788_687_158_244,
  });
});

test("days carry the model id and the alias, not one instead of the other", async () => {
  const context = await claudeFixture();
  await context.write("a.jsonl", [claudeUsage("msg_a", 100)]);

  const report = await createUsageScanner(context).scan();
  expect(report.vendors[1]!.days[0]!.byModel[0])
    .toMatchObject({ model: "claude-opus-5", alias: "opus 5" });
});
