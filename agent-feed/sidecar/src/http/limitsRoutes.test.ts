import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import type { QuotaReport, UsageReport } from "@agentdesk/agent-feed-wire";
import { noteRateLimitHeaders, resetLiveQuotas } from "@/usage/claudeLiveQuota";
import type { UsageScanner } from "@/usage/usageReport";
import { createLimitsRoutes } from "@/http/limitsRoutes";

const server = { timeout() {} } as never;

beforeEach(() => {
  resetLiveQuotas();
});

function get(path = "/api/limits"): [Request, URL] {
  const url = new URL(`http://127.0.0.1${path}`);
  return [new Request(url.toString()), url];
}

/** A scanner that has never swept, which is every sidecar until somebody opens the Usage modal. */
function unswept(cached: UsageReport | null = null): UsageScanner {
  return {
    cached: () => cached,
    scan: () => {
      throw new Error("the limits route must never start a sweep");
    },
  };
}

/** Paths that exist nowhere, so a test never reads the machine it runs on. */
function nowhere(claudeConfig = join(tmpdir(), "limits-route-nothing-here.json")) {
  const root = join(tmpdir(), "limits-route-nothing-here");
  return { codexHome: join(root, "codex"), claudeProjects: join(root, "projects"), claudeConfig };
}

/** The response headers the proxy observes on an Anthropic call, as the observer publishes them. */
function rateLimitHeaders(fiveHour: number, sevenDay: number) {
  return [
    { name: "anthropic-ratelimit-unified-5h-utilization", value: String(fiveHour) },
    { name: "anthropic-ratelimit-unified-5h-reset", value: "1789528800" },
    { name: "anthropic-ratelimit-unified-7d-utilization", value: String(sevenDay) },
    { name: "anthropic-ratelimit-unified-7d-reset", value: "1789920000" },
  ];
}

async function read(route: ReturnType<typeof createLimitsRoutes>): Promise<QuotaReport> {
  const response = await route(...get(), server);
  expect(response?.status).toBe(200);
  return await response!.json() as QuotaReport;
}

test("the meters are answered from the observed headers without sweeping anything", async () => {
  // The whole reason this route exists beside `/api/usage`: the popover asks several times a
  // session, and the report behind it reads every transcript on the machine. The scanner here
  // throws if a sweep is started.
  noteRateLimitHeaders(rateLimitHeaders(0.41, 0.63), Date.now());

  const report = await read(createLimitsRoutes(unswept(), nowhere()));
  const claude = report.vendors.find((vendor) => vendor.vendor === "claude")!;
  expect(claude.quotas.map((quota) => [quota.label, quota.usedPercent])).toEqual([
    ["5-hour limit", 41],
    ["Weekly limit", 63],
  ]);
});

test("a live reading beats the CLI's older config cache", async () => {
  // Newest wins whole. The config is written only occasionally and can be days old, while the
  // headers are from the last response.
  const configPath = join(await mkdtemp(join(tmpdir(), "limits-route-")), "claude.json");
  await writeFile(configPath, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 1_000,
      utilization: { five_hour: { utilization: 0.99, resets_at: 1_789_000_000 } },
    },
  }), "utf8");
  noteRateLimitHeaders(rateLimitHeaders(0.05, 0.1), 2_000);

  const report = await read(createLimitsRoutes(unswept(), nowhere(configPath)));
  const claude = report.vendors.find((vendor) => vendor.vendor === "claude")!;
  expect(claude.quotas.map((quota) => quota.usedPercent)).toEqual([5, 10]);
});

test("with nothing observed yet the config cache still answers", async () => {
  const configPath = join(await mkdtemp(join(tmpdir(), "limits-route-")), "claude.json");
  await writeFile(configPath, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 1_000,
      utilization: { five_hour: { utilization: 0.77, resets_at: 1_789_000_000 } },
    },
  }), "utf8");

  const report = await read(createLimitsRoutes(unswept(), nowhere(configPath)));
  expect(report.vendors[1]!.quotas.map((quota) => quota.usedPercent)).toEqual([77]);
});

test("a machine with no reading answers with empty lists rather than a 404", async () => {
  // Both vendors always appear. A missing vendor would be indistinguishable from a route that
  // failed, and the panel draws "no meter" differently from "could not ask".
  const report = await read(createLimitsRoutes(unswept(), nowhere()));

  expect(report.vendors.map((vendor) => vendor.vendor)).toEqual(["codex", "claude"]);
  expect(report.vendors.every((vendor) => vendor.quotas.length === 0)).toBe(true);
});

test("Codex's meter rides on the last sweep, because it is stamped on rollout records", async () => {
  const swept = {
    vendors: [{
      vendor: "codex" as const,
      displayName: "Codex",
      installed: true,
      days: [],
      quotas: [{
        label: "Weekly limit",
        usedPercent: 22,
        windowMinutes: 10_080,
        resetsAt: 1_789_500_000_000,
        scope: null,
        planType: "prolite",
        sampledAt: 1_789_000_000_000,
      }],
      coverage: { from: null, to: null, sessions: 0, unreadable: 0 },
      scannedAt: 1_789_000_000_000,
    }],
  };

  const report = await read(createLimitsRoutes(unswept(swept), nowhere()));
  expect(report.vendors[0]!.quotas[0]!.usedPercent).toBe(22);
});

test("only GET on the route itself is answered", async () => {
  const route = createLimitsRoutes(unswept(), nowhere());
  const [, url] = get();

  expect(route(new Request(url.toString(), { method: "POST" }), url, server)).toBeUndefined();
  expect(route(...get("/api/limits/extra"), server)).toBeUndefined();
});
