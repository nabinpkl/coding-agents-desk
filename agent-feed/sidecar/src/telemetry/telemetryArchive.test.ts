// The archive's promise is a byte cap that holds however long it runs, without touching anything
// it did not write, and lines a search can read without parsing the envelope inside them.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeEnvelope, TelemetryArchive } from "@/telemetry/telemetryArchive";

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "telemetry-archive-"));
  made.push(dir);
  return dir;
}

const TRACE = "0123456789abcdef0123456789abcdef";

const spanEnvelope = [
  JSON.stringify({ sent_at: "2026-10-14T03:32:17.820Z" }),
  JSON.stringify({ type: "span", item_count: 2 }),
  JSON.stringify({
    version: 2,
    items: [
      { name: "inner work", trace_id: TRACE, is_segment: false, start_timestamp: 10, end_timestamp: 10.02 },
      {
        name: "GET /api/bots",
        trace_id: TRACE,
        is_segment: true,
        start_timestamp: 10,
        end_timestamp: 10.25,
        attributes: { "sentry.op": { value: "http.server", type: "string" } },
      },
    ],
  }),
].join("\n");

const transactionEnvelope = [
  JSON.stringify({ event_id: "e1", trace: { trace_id: TRACE } }),
  JSON.stringify({ type: "transaction" }),
  JSON.stringify({ transaction: "/", start_timestamp: 5, timestamp: 8.5, contexts: { trace: { op: "pageload" } } }),
].join("\n");

test("summarizes streamed spans by their segment, and a transaction by its own name", () => {
  expect(summarizeEnvelope(spanEnvelope)).toEqual({
    types: ["span"],
    traceId: TRACE,
    name: "GET /api/bots",
    op: "http.server",
    durationMs: 250,
  });
  const children = spanEnvelope
    .replace('"is_segment":true', '"is_segment":false')
    .replace('"name":"inner work"', '"name":"inner work","attributes":{"sentry.segment.name":{"value":"Pageload"}}');
  // A batch of a load's children names the load it belongs to, and claims neither its name nor
  // its duration: that is the segment's own envelope to say.
  expect(summarizeEnvelope(children)).toEqual({ types: ["span"], traceId: TRACE, segment: "Pageload" });
  expect(summarizeEnvelope(transactionEnvelope)).toEqual({
    types: ["transaction"],
    traceId: TRACE,
    name: "/",
    op: "pageload",
    durationMs: 3500,
  });
  expect(summarizeEnvelope("not json")).toEqual({ types: [] });
});

test("writes one line per envelope, carrying the summary and the envelope verbatim", () => {
  const dir = scratch();
  new TelemetryArchive(dir, 1024 * 1024, 1024 * 1024, () => Date.UTC(2026, 9, 14)).append("sidecar", spanEnvelope);
  const [name] = readdirSync(dir);
  const line = JSON.parse(readFileSync(join(dir, name!), "utf8").trim());
  expect(line).toMatchObject({ at: "2026-10-14T00:00:00.000Z", source: "sidecar", traceId: TRACE, durationMs: 250 });
  expect(line.envelope).toBe(spanEnvelope);
});

test("holds the directory under its cap by deleting the oldest segments, and only its own files", () => {
  const dir = scratch();
  writeFileSync(join(dir, "notes.txt"), "not a segment");
  let clock = 1_000_000_000_000;
  const archive = new TelemetryArchive(dir, 20_000, 4_000, () => clock++);
  for (let i = 0; i < 200; i += 1) archive.append("panel", spanEnvelope);
  const segments = readdirSync(dir).filter((name) => name.endsWith(".ndjson"));
  const bytes = segments.reduce((sum, name) => sum + readFileSync(join(dir, name)).length, 0);
  expect(bytes).toBeLessThanOrEqual(20_000);
  expect(bytes).toBe(archive.size);
  expect(segments.length).toBeGreaterThan(1);
  expect(readdirSync(dir)).toContain("notes.txt");
});

test("counts what an earlier run left toward the cap", () => {
  const dir = scratch();
  let clock = 1_000_000_000_000;
  const first = new TelemetryArchive(dir, 1024 * 1024, 4_000, () => clock++);
  for (let i = 0; i < 10; i += 1) first.append("panel", spanEnvelope);
  expect(new TelemetryArchive(dir, 1024 * 1024, 4_000, () => clock++).size).toBe(first.size);
});

test("refuses a relative directory rather than resolving it against wherever it runs", () => {
  expect(() => new TelemetryArchive("telemetry", 1024)).toThrow("absolute");
});
