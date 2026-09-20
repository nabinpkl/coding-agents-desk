import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { QuotaReport, UsageReport } from "@agentdesk/agent-feed-wire";
import type { UsageScanner } from "@/usage/usageReport";
import { createLimitsRoutes } from "@/http/limitsRoutes";

const server = { timeout() {} } as never;

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

async function mirror(body: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "limits-route-")), "mirror.json");
  await writeFile(path, JSON.stringify(body), "utf8");
  return path;
}

/** Paths that exist nowhere, so a test never reads the machine it runs on. */
function nowhere(claudeLimitsMirror: string) {
  const root = join(tmpdir(), "limits-route-nothing-here");
  return {
    codexHome: join(root, "codex"),
    claudeProjects: join(root, "projects"),
    claudeConfig: join(root, "claude.json"),
    claudeLimitsMirror,
  };
}

async function read(route: ReturnType<typeof createLimitsRoutes>): Promise<QuotaReport> {
  const response = await route(...get(), server);
  expect(response?.status).toBe(200);
  return await response!.json() as QuotaReport;
}

test("the meters are answered from the mirror without sweeping anything", async () => {
  // The whole reason this route exists beside `/api/usage`: the popover asks several times a
  // session, and the report behind it reads every transcript on the machine. The scanner here
  // throws if a sweep is started.
  const path = await mirror({
    fetchedAtMs: 1_789_000_000_000,
    rate_limits: {
      five_hour: { used_percentage: 41, resets_at: 1_789_010_000 },
      seven_day: { used_percentage: 63, resets_at: 1_789_500_000 },
    },
  });

  const report = await read(createLimitsRoutes(unswept(), nowhere(path)));
  const claude = report.vendors.find((vendor) => vendor.vendor === "claude")!;
  expect(claude.quotas.map((quota) => [quota.label, quota.usedPercent])).toEqual([
    ["5-hour limit", 41],
    ["Weekly limit", 63],
  ]);
});

test("a machine with no reading answers with empty lists rather than a 404", async () => {
  // Both vendors always appear. A missing vendor would be indistinguishable from a route that
  // failed, and the panel draws "no meter" differently from "could not ask".
  const report = await read(createLimitsRoutes(unswept(), nowhere(join(tmpdir(), "no-mirror.json"))));

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
        planType: "prolite",
        sampledAt: 1_789_000_000_000,
      }],
      coverage: { from: null, to: null, sessions: 0, unreadable: 0 },
      scannedAt: 1_789_000_000_000,
    }],
  };

  const report = await read(
    createLimitsRoutes(unswept(swept), nowhere(join(tmpdir(), "no-mirror.json"))),
  );
  expect(report.vendors[0]!.quotas[0]!.usedPercent).toBe(22);
});

test("only GET on the route itself is answered", async () => {
  const route = createLimitsRoutes(unswept(), nowhere(join(tmpdir(), "no-mirror.json")));
  const [, url] = get();

  expect(route(new Request(url.toString(), { method: "POST" }), url, server)).toBeUndefined();
  expect(route(...get("/api/limits/extra"), server)).toBeUndefined();
});
