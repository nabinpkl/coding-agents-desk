import { expect, test } from "bun:test";
import type { UsageReport, UsageStreamMessage } from "@agentdesk/agent-feed-wire";
import type { UsageScanner } from "../usage/usageReport.ts";
import { createUsageRoutes } from "./usageRoutes.ts";

const server = { timeout() {} } as never;

function report(inputTokens: number): UsageReport {
  return {
    vendors: [{
      vendor: "codex",
      displayName: "Codex",
      installed: true,
      days: [{
        date: "2026-08-13",
        totals: { inputTokens, cachedInputTokens: 60, outputTokens: 5, reasoningTokens: 1, requests: 2 },
        byModel: [{
          model: "gpt-5.6-sol",
          totals: { inputTokens, cachedInputTokens: 60, outputTokens: 5, reasoningTokens: 1, requests: 2 },
        }],
      }],
      quota: null,
      coverage: { from: "2026-08-13", to: "2026-08-13", sessions: 1, unreadable: 0 },
      scannedAt: 1_750_000_000_000,
    }],
  };
}

function scanner(options: {
  cached?: UsageReport | null;
  scan: () => Promise<UsageReport>;
}): UsageScanner {
  return { cached: () => options.cached ?? null, scan: options.scan };
}

function get(path = "/api/usage"): [Request, URL] {
  const url = new URL(`http://127.0.0.1${path}`);
  return [new Request(url.toString()), url];
}

/** Everything one stream said. Returns only because the route closes itself. */
async function collect(response: Response): Promise<UsageStreamMessage[]> {
  return (await response.text())
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as UsageStreamMessage);
}

test("a POST is not this route's business", async () => {
  const route = createUsageRoutes(scanner({ scan: async () => report(1) }));
  const url = new URL("http://127.0.0.1/api/usage");
  expect(route(new Request(url.toString(), { method: "POST" }), url, server)).toBeUndefined();
});

test("another path is not this route's business", async () => {
  const route = createUsageRoutes(scanner({ scan: async () => report(1) }));
  const url = new URL("http://127.0.0.1/api/usage/codex");
  expect(route(new Request(url.toString()), url, server)).toBeUndefined();
});

test("a cold reader gets exactly one report, after the sweep", async () => {
  const route = createUsageRoutes(scanner({ cached: null, scan: async () => report(100) }));
  const response = await route(...get(), server)!;
  expect(response.headers.get("content-type")).toBe("text/event-stream");

  const messages = await collect(response);
  expect(messages).toEqual([{ type: "report", report: report(100) }, { type: "settled" }]);
});

test("a warm reader is painted from cache first, then corrected", async () => {
  // The reason this is a stream and not a JSON body: the cache answers in microseconds and the
  // sweep takes seconds on a cold cache, and a reader deserves both rather than a choice.
  const stale = report(100);
  const fresh = report(150);
  const route = createUsageRoutes(scanner({ cached: stale, scan: async () => fresh }));

  const messages = await collect(await route(...get(), server)!);
  expect(messages).toEqual([
    { type: "report", report: stale },
    { type: "report", report: fresh },
    { type: "settled" },
  ]);
});

test("a sweep that changed nothing does not make the panel render twice", async () => {
  // The scanner returns its previous report object when no file moved, and identity is what says
  // so. Without this every open would paint the same numbers twice.
  const unchanged = report(100);
  const route = createUsageRoutes(scanner({ cached: unchanged, scan: async () => unchanged }));

  expect(await collect(await route(...get(), server)!)).toEqual([
    { type: "report", report: unchanged },
    // Still terminated explicitly: "the sweep found nothing" and "the sweep is still going" are
    // different answers, and a stream that just goes quiet gives the reader only one of them.
    { type: "settled" },
  ]);
});

test("a failed sweep is reported in the stream, since the status is already committed", async () => {
  const route = createUsageRoutes(scanner({
    scan: async () => {
      throw new Error("disk went away");
    },
  }));

  const messages = await collect(await route(...get(), server)!);
  expect(messages).toEqual([{
    type: "error",
    error: { code: "usage-scan-failed", message: "disk went away", retryable: true },
  }]);
});

test("a failed sweep still shows what the cache had", async () => {
  const stale = report(100);
  const route = createUsageRoutes(scanner({
    cached: stale,
    scan: async () => {
      throw new Error("nope");
    },
  }));

  const messages = await collect(await route(...get(), server)!);
  expect(messages[0]).toEqual({ type: "report", report: stale });
  expect(messages[1]?.type).toBe("error");
});
