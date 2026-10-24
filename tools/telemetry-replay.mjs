#!/usr/bin/env node
// Reads the telemetry archive (`agent-feed/sidecar/src/telemetry/telemetryArchive.ts`): every
// envelope the panel and the sidecar produced, kept under a byte cap. Spotlight holds only its
// last 500 in memory, so this is how an old slow load gets back in front of a viewer.
//
//   node tools/telemetry-replay.mjs list  [--since 2026-10-14T03:00] [--min-ms 3000] [--name Pageload] [--op pageload]
//   node tools/telemetry-replay.mjs memory [--since 2026-10-14T03:00] [--source panel|sidecar]
//   node tools/telemetry-replay.mjs reconnects [--since 2026-10-14T03:00] [--min-ms 3000]
//   node tools/telemetry-replay.mjs trace <trace-id>
//   node tools/telemetry-replay.mjs replay <trace-id> [--spotlight http://127.0.0.1:8969/stream]
//
// `list` prints one line per envelope that names a request or a load (its segment), newest last.
// `memory` prints every memory reading, the panel's and the sidecar's, oldest first.
// `reconnects` prints each time the panel's streams dropped and came back (`streamReconnects.ts`),
// oldest first: how long, how many streams and tries, how long the page had slept, and the slowest.
// `trace` prints every span of one trace, panel and sidecar together, as a tree timed from the
// trace's start. `replay` sends that trace's envelopes to Spotlight, verbatim, to read there.

import { createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runtimePaths } from "./runtime-paths.mjs";

const [command, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
  const at = rest.indexOf(name);
  return at === -1 ? fallback : rest[at + 1];
};
const directory = process.env.AGENTDESK_TELEMETRY_ARCHIVE || runtimePaths().telemetryArchive;

/** Every archived line, oldest first. */
async function* lines() {
  const segments = readdirSync(directory)
    .filter((name) => /^telemetry-\d{13}\.ndjson$/.test(name))
    .sort();
  for (const name of segments) {
    const reader = createInterface({ input: createReadStream(join(directory, name)), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // A line cut short by a crash mid-write; the rest of the segment is still good.
      }
    }
  }
}

/** The spans an envelope carries, in either shape the SDKs send. */
function spansOf(envelope) {
  const parts = envelope.split("\n");
  const spans = [];
  for (let at = 1; at + 1 < parts.length; at += 2) {
    let header;
    let payload;
    try {
      header = JSON.parse(parts[at]);
      payload = JSON.parse(parts[at + 1]);
    } catch {
      continue;
    }
    if (header.type === "span") {
      for (const span of payload.items ?? []) {
        spans.push({
          id: span.span_id,
          parent: span.parent_span_id,
          name: requestName(span.name, span.attributes?.["url.full"]?.value),
          start: span.start_timestamp,
          end: span.end_timestamp,
          op: span.attributes?.["sentry.op"]?.value,
          status: span.status,
        });
      }
    } else if (header.type === "transaction") {
      const trace = payload.contexts?.trace ?? {};
      spans.push({
        id: trace.span_id,
        parent: trace.parent_span_id,
        name: payload.transaction,
        start: payload.start_timestamp,
        end: payload.timestamp,
        op: trace.op,
        status: trace.status,
      });
      for (const span of payload.spans ?? []) {
        spans.push({
          id: span.span_id,
          parent: span.parent_span_id,
          name: requestName(span.description, span.data?.["url.full"]),
          start: span.start_timestamp,
          end: span.timestamp,
          op: span.op,
          status: span.status,
        });
      }
    }
  }
  return spans;
}

const ms = (seconds) => Math.round(seconds * 1000);

/** A request span is named for its host; the path is what says which request it was. */
function requestName(name, url) {
  if (typeof url !== "string" || typeof name !== "string") return name;
  try {
    const { pathname, search } = new URL(url);
    return `${name.split(" ")[0]} ${pathname}${search}`;
  } catch {
    return name;
  }
}

async function list() {
  const since = option("--since", "");
  const minMs = Number(option("--min-ms", "0"));
  const name = option("--name", "");
  const op = option("--op", "");
  for await (const line of lines()) {
    if (line.name === undefined || (since && line.at < since)) continue;
    if ((line.durationMs ?? 0) < minMs || (name && !line.name.includes(name)) || (op && line.op !== op)) continue;
    console.log(
      `${line.at}  ${line.source.padEnd(7)} ${String(line.durationMs ?? "-").padStart(6)}ms  ${(line.op ?? "-").padEnd(12)} ${line.name}  ${line.traceId ?? ""}`,
    );
  }
}

/** The memory figures on an envelope's transaction (`pageMemory.ts`, `sidecarMemory.ts`), or null. */
function memoryOf(envelope) {
  const parts = envelope.split("\n");
  for (let at = 1; at + 1 < parts.length; at += 2) {
    let header;
    let payload;
    try {
      header = JSON.parse(parts[at]);
      payload = JSON.parse(parts[at + 1]);
    } catch {
      continue;
    }
    if (header.type !== "transaction") continue;
    const data = payload.contexts?.trace?.data ?? {};
    const figures = Object.entries(data).filter(([key]) => /^(page\.|process\.(memory\.|uptime))/.test(key));
    return figures.length > 0 ? Object.fromEntries(figures) : null;
  }
  return null;
}

const MB = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)}MB`;

/** One reading per line: the panel's at each load's end and every twenty minutes, the sidecar's every five. */
async function memory() {
  const since = option("--since", "");
  const source = option("--source", "");
  for await (const line of lines()) {
    if (!["pageload", "ui.memory", "app.memory"].includes(line.op) || (since && line.at < since)) continue;
    if (source && line.source !== source) continue;
    const m = memoryOf(line.envelope);
    if (!m) continue;
    const figures =
      line.source === "sidecar"
        ? `rss ${MB(m["process.memory.rss"])}  heap ${MB(m["process.memory.heap_used"])}/${MB(m["process.memory.heap_total"])}  external ${MB(m["process.memory.external"])}  buffers ${MB(m["process.memory.array_buffers"])}  up ${Math.round(m["process.uptime_s"] / 60)}min`
        : `${m["page.js_heap.used"] === undefined ? "heap -" : `heap ${MB(m["page.js_heap.used"])}/${MB(m["page.js_heap.total"])}`}  elements ${m["page.dom_elements"]}${m["page.visible"] === false ? "  (hidden)" : ""}`;
    console.log(`${line.at}  ${line.source.padEnd(7)} ${line.op.padEnd(10)} ${figures}`);
  }
}

/** The device a panel transaction came from, by its user agent. */
function deviceOf(payload) {
  const agent = payload.request?.headers?.["User-Agent"] ?? "";
  if (agent.includes("iPhone")) return "iphone";
  if (agent.includes("Headless")) return "headless";
  return agent.includes("Macintosh") ? "mac" : "-";
}

const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)}s`;

/** One line per reconnect: its span's figures and the stream that took longest to come back. */
async function reconnects() {
  const since = option("--since", "");
  const minMs = Number(option("--min-ms", "0"));
  for await (const line of lines()) {
    if (line.op !== "ui.stream.reconnect" || (since && line.at < since) || (line.durationMs ?? 0) < minMs) continue;
    const parts = line.envelope.split("\n");
    for (let at = 1; at + 1 < parts.length; at += 2) {
      let header;
      let payload;
      try {
        header = JSON.parse(parts[at]);
        payload = JSON.parse(parts[at + 1]);
      } catch {
        continue;
      }
      if (header.type !== "transaction") continue;
      const data = payload.contexts?.trace?.data ?? {};
      const streams = (payload.spans ?? []).map((span) => ({
        name: span.description,
        ms: ms(span.timestamp - span.start_timestamp),
        tries: span.data?.["stream.tries"],
        outcome: span.data?.["stream.outcome"],
      }));
      const slowest = streams.sort((a, b) => b.ms - a.ms)[0];
      const outcomes = ["back", "down", "closed"]
        .filter((outcome) => data[`reconnect.${outcome}`] > 0)
        .map((outcome) => `${data[`reconnect.${outcome}`]} ${outcome}`)
        .join(", ");
      const slept =
        data["page.hidden_ms"] === undefined
          ? "no wake yet"
          : `woke ${seconds(data["page.since_wake_ms"])} before, after ${seconds(data["page.hidden_ms"])} hidden`;
      console.log(
        `${line.at}  ${deviceOf(payload).padEnd(8)} ${String(line.durationMs ?? "-").padStart(6)}ms  ${data["reconnect.streams"]} streams (${outcomes})  ${data["reconnect.tries"]} tries  ${data["reconnect.cause"]}  ${slept}${slowest ? `  slowest ${slowest.name} ${slowest.ms}ms, ${slowest.tries} tries, ${slowest.outcome}` : ""}`,
      );
    }
  }
}

async function collect(traceId) {
  const envelopes = [];
  for await (const line of lines()) if (line.traceId === traceId) envelopes.push(line);
  return envelopes;
}

async function trace(traceId) {
  const envelopes = await collect(traceId);
  if (envelopes.length === 0) throw new Error(`no envelopes for trace ${traceId} in ${directory}`);
  const spans = envelopes.flatMap((line) => spansOf(line.envelope).map((span) => ({ ...span, source: line.source })));
  const origin = Math.min(...spans.map((span) => span.start));
  const ids = new Set(spans.map((span) => span.id));
  const children = new Map();
  for (const span of spans) {
    const parent = ids.has(span.parent) ? span.parent : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(span);
  }
  const print = (parent, depth) => {
    for (const span of (children.get(parent) ?? []).sort((a, b) => a.start - b.start)) {
      const status = span.status && span.status !== "ok" ? ` [${span.status}]` : "";
      console.log(
        `${String(ms(span.start - origin)).padStart(7)}ms ${String(ms(span.end - span.start)).padStart(6)}ms  ${"  ".repeat(depth)}${span.source === "sidecar" ? "(sidecar) " : ""}${span.op ?? "-"}  ${span.name}${status}`,
      );
      print(span.id, depth + 1);
    }
  };
  console.log(
    `trace ${traceId}: ${envelopes.length} envelopes, ${spans.length} spans, offsets from the first span's start`,
  );
  print(null, 0);
}

async function replay(traceId) {
  const target = option("--spotlight", process.env.AGENT_FEED_SPOTLIGHT_URL || "http://127.0.0.1:8969/stream");
  const envelopes = await collect(traceId);
  if (envelopes.length === 0) throw new Error(`no envelopes for trace ${traceId} in ${directory}`);
  for (const line of envelopes) {
    const response = await fetch(target, {
      method: "POST",
      body: line.envelope,
      headers: { "content-type": "application/x-sentry-envelope" },
    });
    if (!response.ok) throw new Error(`Spotlight answered ${response.status} at ${target}`);
  }
  console.log(`sent ${envelopes.length} envelopes of trace ${traceId} to ${target}`);
}

const commands = { list, memory, reconnects, trace: () => trace(rest[0]), replay: () => replay(rest[0]) };
if (!commands[command] || (!["list", "memory", "reconnects"].includes(command) && !rest[0])) {
  console.error(
    "usage: telemetry-replay.mjs list [--since <iso>] [--min-ms <n>] [--name <text>] [--op <op>] | memory [--since <iso>] [--source panel|sidecar] | reconnects [--since <iso>] [--min-ms <n>] | trace <trace-id> | replay <trace-id> [--spotlight <url>]",
  );
  process.exit(2);
}
await commands[command]();
