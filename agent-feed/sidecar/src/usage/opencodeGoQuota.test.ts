import { expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGoQuotas, parseGoUsage } from "@/usage/opencodeGoQuota";
import { createOpencodeGoSource } from "@/usage/opencodeGoLimits";
import { readOpencodeGoKey } from "@/config/configOpencode";

const window = (percent: unknown, resetsAt: unknown = "2026-10-16T08:34:37.000Z", status: unknown = "ok") => ({
  status,
  percent,
  resetsAt,
});
const body = {
  usage: { rolling: window(0), weekly: window(41.6), monthly: window(100) },
};
const url = new URL("https://example.invalid/usage");

test("parses the three windows, keeps 0 as 0 and passes status through", () => {
  const quotas = parseGoUsage(body, 5)!;
  expect(quotas.map((q) => [q.windowMinutes, q.usedPercent, q.status])).toEqual([
    [300, 0, "ok"],
    [10080, 42, "ok"],
    [43200, 100, "ok"],
  ]);
  expect(quotas[0]!.resetsAt).toBe(Date.parse("2026-10-16T08:34:37.000Z"));
  expect(quotas[0]!.sampledAt).toBe(5);
});

test("passes an unseen status string through untouched", () => {
  expect(parseGoUsage({ usage: { rolling: window(3, undefined, "throttled") } }, 0)![0]!.status).toBe("throttled");
});

test("drops a window with any bad field, keeps the rest, and returns null when none survive", () => {
  const mixed = { usage: { rolling: window("3"), weekly: window(5, "nope"), monthly: window(7) } };
  expect(parseGoUsage(mixed, 0)!.map((q) => q.windowMinutes)).toEqual([43200]);
  expect(parseGoUsage({ usage: { rolling: window(101) } }, 0)).toBeNull();
  expect(parseGoUsage({ usage: { rolling: window(-1) } }, 0)).toBeNull();
  expect(parseGoUsage({ usage: { rolling: { percent: 1, resetsAt: "2026-10-16T08:34:37.000Z" } } }, 0)).toBeNull();
  for (const bad of [null, undefined, 3, "x", {}, { usage: null }, { usage: [] }]) {
    expect(parseGoUsage(bad, 0)).toBeNull();
  }
});

test("a non-200, a bad body and a thrown request are all unavailable, never zero", async () => {
  const run = (impl: () => Promise<Response>) =>
    fetchGoQuotas({ fetch: impl as never, url, key: "secret-key", now: () => 1 });
  const refused = await run(async () => new Response("no", { status: 401 }));
  expect(refused).toMatchObject({ vendor: "opencode-go", quotas: [], unavailable: "HTTP 401" });
  const shape = await run(async () => Response.json({ usage: {} }));
  expect(shape.unavailable).toBe("unexpected response shape");
  const notJson = await run(async () => new Response("<html>"));
  expect(notJson.unavailable).toBe("request failed");
  const thrown = await run(async () => {
    throw new Error("boom secret-key");
  });
  expect(JSON.stringify(thrown)).not.toContain("secret-key");
});

test("sends the key as a bearer and returns quotas on 200", async () => {
  let auth = "";
  const result = await fetchGoQuotas({
    fetch: (async (_url: URL, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization!;
      return Response.json(body);
    }) as never,
    url,
    key: "k1",
    now: () => 9,
  });
  expect(auth).toBe("Bearer k1");
  expect(result.quotas).toHaveLength(3);
  expect(result.unavailable).toBeUndefined();
});

test("reads the key only from the opencode-go entry; absent or malformed is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "go-auth-"));
  try {
    const path = join(dir, "auth.json");
    expect(readOpencodeGoKey(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ other: { key: "x" } }));
    expect(readOpencodeGoKey(path)).toBeNull();
    writeFileSync(path, "{not json");
    expect(readOpencodeGoKey(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ "opencode-go": { type: "api", key: " abc " } }));
    expect(readOpencodeGoKey(path)).toBe("abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the source polls only while subscribed and makes no request without a key", async () => {
  let calls = 0;
  let key: string | null = null;
  const source = createOpencodeGoSource({
    readKey: () => key,
    url: () => url,
    pollMs: 5,
    fetch: (async () => {
      calls += 1;
      return Response.json(body);
    }) as never,
  });
  const off = source.subscribe(() => {});
  await Bun.sleep(30);
  expect(calls).toBe(0);
  expect(source.current()).toBeNull();
  key = "k";
  await Bun.sleep(30);
  expect(source.current()?.quotas).toHaveLength(3);
  off();
  const after = calls;
  await Bun.sleep(30);
  expect(calls).toBe(after);
  expect(source.current()).toBeNull();
});

test("a poll that finishes after the last reader left leaves nothing behind", async () => {
  let release: (() => void) | null = null;
  const source = createOpencodeGoSource({
    readKey: () => "k",
    url: () => url,
    pollMs: 60_000,
    fetch: (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json(body);
    }) as never,
  });
  const off = source.subscribe(() => {});
  await Bun.sleep(5);
  off();
  release!();
  await Bun.sleep(10);
  expect(source.current()).toBeNull();
});
