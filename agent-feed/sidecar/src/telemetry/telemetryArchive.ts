// Every telemetry envelope this machine produced, kept on disk under a byte cap.
//
// Spotlight is the viewer, and it holds its last 500 envelopes in memory only, which is the wrong
// shape for the question this exists to answer: a load that was slow once, last Tuesday. So each
// envelope is also written here, whole, and `tools/telemetry-replay.mjs` sends the ones a search
// picks back into Spotlight to be read as a trace.
//
// One JSON line per envelope, in segment files named for the moment they were started. The line
// carries a few fields lifted out of the envelope (trace id, item types, transaction name and
// duration) so a search can be a `grep` or a line filter rather than a parse of every envelope,
// and the envelope itself verbatim so a replay hands Spotlight exactly what the SDK sent.
//
// The cap is on the whole directory. A segment is closed once it passes its own size, and the
// oldest segments are deleted until the total is back under the cap. Deletion is confined to this
// directory and to names this module writes.

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const SEGMENT = /^telemetry-(\d{13})\.ndjson$/;

export type TelemetrySource = "panel" | "sidecar";

/**
 * What a search needs from an envelope without parsing it. `name`, `op` and `durationMs` describe
 * the request or load the envelope completes, and are set only when it carries that span itself;
 * a batch of its children names it in `segment` instead, so a listing shows each load once.
 */
export type EnvelopeSummary = {
  traceId?: string;
  types: string[];
  segment?: string;
  name?: string;
  op?: string;
  durationMs?: number;
};

/**
 * Reads an envelope's header and items. An envelope is a header line, then for each item a header
 * line and a payload line; every payload this repo's SDKs send is JSON on one line.
 */
export function summarizeEnvelope(envelope: string): EnvelopeSummary {
  const lines = envelope.split("\n");
  const summary: EnvelopeSummary = { types: [] };
  const header = parseObject(lines[0]);
  const trace = header?.trace as { trace_id?: unknown } | undefined;
  if (typeof trace?.trace_id === "string") summary.traceId = trace.trace_id;
  for (let at = 1; at + 1 < lines.length; at += 2) {
    const item = parseObject(lines[at]);
    if (typeof item?.type !== "string") break;
    summary.types.push(item.type);
    if (item.type === "span") summarizeSpans(parseObject(lines[at + 1]), summary);
    if (item.type !== "transaction") continue;
    const payload = parseObject(lines[at + 1]);
    if (!payload) continue;
    if (typeof payload.transaction === "string") summary.name = payload.transaction;
    const context = (payload.contexts as { trace?: { op?: unknown; trace_id?: unknown } } | undefined)?.trace;
    if (typeof context?.op === "string") summary.op = context.op;
    if (!summary.traceId && typeof context?.trace_id === "string") summary.traceId = context.trace_id;
    if (typeof payload.start_timestamp === "number" && typeof payload.timestamp === "number") {
      summary.durationMs = Math.round((payload.timestamp - payload.start_timestamp) * 1000);
    }
  }
  return summary;
}

type StreamedSpan = {
  name?: unknown;
  trace_id?: unknown;
  is_segment?: unknown;
  start_timestamp?: unknown;
  end_timestamp?: unknown;
  attributes?: { "sentry.op"?: { value?: unknown }; "sentry.segment.name"?: { value?: unknown } };
};

/**
 * Streamed spans (`span` items, version 2), which SDK 11 sends instead of a transaction: batches
 * of spans, the segment -- the request or page load they belong to -- in whichever batch is sent
 * when it ends. A page load's children usually arrive first.
 */
function summarizeSpans(payload: Record<string, unknown> | null, summary: EnvelopeSummary): void {
  const items = Array.isArray(payload?.items) ? (payload.items as StreamedSpan[]) : [];
  const first = items[0];
  if (!first) return;
  if (!summary.traceId && typeof first.trace_id === "string") summary.traceId = first.trace_id;
  const segmentName = first.attributes?.["sentry.segment.name"]?.value;
  if (summary.segment === undefined && typeof segmentName === "string") summary.segment = segmentName;
  const span = items.find((item) => item.is_segment === true);
  if (!span || summary.name !== undefined) return;
  if (typeof span.name === "string") summary.name = span.name;
  const op = span.attributes?.["sentry.op"]?.value;
  if (typeof op === "string") summary.op = op;
  if (typeof span.start_timestamp === "number" && typeof span.end_timestamp === "number") {
    summary.durationMs = Math.round((span.end_timestamp - span.start_timestamp) * 1000);
  }
}

function parseObject(line: string | undefined): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class TelemetryArchive {
  private readonly segments: { name: string; bytes: number }[] = [];
  private total = 0;

  /**
   * @param directory absolute, and owned by this archive: every segment-named file in it counts
   *   toward the cap and may be deleted.
   */
  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly segmentBytes = Math.max(1, Math.floor(maxBytes / 16)),
    private readonly now: () => number = Date.now,
  ) {
    if (!isAbsolute(directory)) throw new Error(`telemetry archive must be an absolute path: ${directory}`);
    mkdirSync(directory, { recursive: true });
    const found = readdirSync(directory).filter((name) => SEGMENT.test(name)).sort();
    for (const name of found) {
      const bytes = statSync(join(directory, name)).size;
      this.segments.push({ name, bytes });
      this.total += bytes;
    }
  }

  /** Bytes on disk across every segment. */
  get size(): number {
    return this.total;
  }

  append(source: TelemetrySource, envelope: string): void {
    const line = `${JSON.stringify({ at: new Date(this.now()).toISOString(), source, ...summarizeEnvelope(envelope), envelope })}\n`;
    const bytes = Buffer.byteLength(line);
    let current = this.segments.at(-1);
    if (!current || current.bytes >= this.segmentBytes) {
      current = { name: this.nextName(), bytes: 0 };
      this.segments.push(current);
    }
    appendFileSync(join(this.directory, current.name), line);
    current.bytes += bytes;
    this.total += bytes;
    // The segment being written is never the one deleted, so one envelope larger than the cap is
    // kept rather than written and immediately thrown away.
    while (this.total > this.maxBytes && this.segments.length > 1) {
      const oldest = this.segments.shift()!;
      unlinkSync(join(this.directory, oldest.name));
      this.total -= oldest.bytes;
    }
  }

  /** Named for its start; two segments started in one millisecond step forward rather than collide. */
  private nextName(): string {
    const last = this.segments.at(-1);
    const after = last ? Number(SEGMENT.exec(last.name)![1]) + 1 : 0;
    return `telemetry-${String(Math.max(this.now(), after)).padStart(13, "0")}.ndjson`;
  }
}
