import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import type { LimitsStreamMessage, UsageReport } from "@agentdesk/agent-feed-wire";
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

/**
 * One reader over an open stream, taken in batches.
 *
 * One reader for the whole stream, not one per read: a second `getReader()` on the same body
 * throws, and this route is endless, so there is never a close to read up to. Cancelling is the
 * caller's: the sidecar drops the subscription the moment its reader is gone.
 */
function streamReader(response: Response): {
  take: (count: number) => Promise<LimitsStreamMessage[]>;
  leave: () => Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const pending: LimitsStreamMessage[] = [];
  let buffer = "";
  return {
    async take(count) {
      while (pending.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("data: ")) {
            pending.push(JSON.parse(frame.slice(6)) as LimitsStreamMessage);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      return pending.splice(0, count);
    },
    leave: () => reader.cancel(),
  };
}

function follow(route: ReturnType<typeof createLimitsRoutes>) {
  const response = route(...get(), server) as Response;
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  return streamReader(response);
}

/** The percentages one report carries for a vendor, which is what every test here is about. */
function percents(message: LimitsStreamMessage, vendor = "claude"): number[] {
  if (message.type !== "report") throw new Error(`expected a report, got ${message.type}`);
  return message.report.vendors.find((each) => each.vendor === vendor)!.quotas
    .map((quota) => quota.usedPercent);
}

test("the meters are answered from the observed headers without sweeping anything", async () => {
  // The whole reason this route exists beside `/api/usage`: the report behind that one reads every
  // transcript on the machine. The scanner here throws if a sweep is started.
  noteRateLimitHeaders(rateLimitHeaders(0.41, 0.63), Date.now());

  const stream = follow(createLimitsRoutes(unswept(), nowhere()));
  const [first] = await stream.take(1);
  expect(percents(first!)).toEqual([41, 63]);
  await stream.leave();
});

test("a response crossing the proxy pushes a new report without being asked", async () => {
  // The point of the stream. The observer hands the sidecar these headers as each request comes
  // back, so a reader learns the window moved in the same moment the sidecar does, rather than on
  // its own timer -- which would be most stale in the seconds after a turn is sent.
  noteRateLimitHeaders(rateLimitHeaders(0.41, 0.63), 1_000);
  const stream = follow(createLimitsRoutes(unswept(), nowhere()));
  expect(percents((await stream.take(1))[0]!)).toEqual([41, 63]);

  noteRateLimitHeaders(rateLimitHeaders(0.42, 0.64), 2_000);

  expect(percents((await stream.take(1))[0]!)).toEqual([42, 64]);
  await stream.leave();
});

test("a reading that is not newer moves nothing, so no report is pushed for it", async () => {
  noteRateLimitHeaders(rateLimitHeaders(0.41, 0.63), 2_000);
  const stream = follow(createLimitsRoutes(unswept(), nowhere()));
  expect(percents((await stream.take(1))[0]!)).toEqual([41, 63]);

  // Older than the reading already held. Newest wins whole, and a stream that re-sent on every
  // flow would spend a reader's attention saying nothing changed.
  noteRateLimitHeaders(rateLimitHeaders(0.99, 0.99), 1_000);
  noteRateLimitHeaders(rateLimitHeaders(0.43, 0.65), 3_000);

  expect(percents((await stream.take(1))[0]!)).toEqual([43, 65]);
  await stream.leave();
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

  const stream = follow(createLimitsRoutes(unswept(), nowhere(configPath)));
  expect(percents((await stream.take(1))[0]!)).toEqual([5, 10]);
  await stream.leave();
});

test("with nothing observed yet the config cache still answers", async () => {
  const configPath = join(await mkdtemp(join(tmpdir(), "limits-route-")), "claude.json");
  await writeFile(configPath, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 1_000,
      utilization: { five_hour: { utilization: 0.77, resets_at: 1_789_000_000 } },
    },
  }), "utf8");

  const stream = follow(createLimitsRoutes(unswept(), nowhere(configPath)));
  expect(percents((await stream.take(1))[0]!)).toEqual([77]);
  await stream.leave();
});

test("a machine with no reading answers with empty lists rather than a 404", async () => {
  // Both vendors always appear. A missing vendor would be indistinguishable from a route that
  // failed, and the panel draws "no meter" differently from "could not ask".
  const stream = follow(createLimitsRoutes(unswept(), nowhere()));
  const [first] = await stream.take(1);
  if (first!.type !== "report") throw new Error("expected a report");
  expect(first!.report.vendors.map((vendor) => vendor.vendor)).toEqual(["codex", "claude"]);
  expect(first!.report.vendors.every((vendor) => vendor.quotas.length === 0)).toBe(true);
  await stream.leave();
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

  const stream = follow(createLimitsRoutes(unswept(swept), nowhere()));
  expect(percents((await stream.take(1))[0]!, "codex")).toEqual([22]);
  await stream.leave();
});

test("only GET on the route itself is answered", () => {
  const route = createLimitsRoutes(unswept(), nowhere());
  const [, url] = get();

  expect(route(new Request(url.toString(), { method: "POST" }), url, server)).toBeUndefined();
  expect(route(...get("/api/limits/extra"), server)).toBeUndefined();
});
