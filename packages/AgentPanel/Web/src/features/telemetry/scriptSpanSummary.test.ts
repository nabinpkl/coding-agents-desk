// A load's script fetches reach the archive as a count on the load and its slowest few spans.

import type { Event } from "@sentry/react";
import { describe, expect, it } from "vitest";
import { KEPT_SCRIPT_SPANS, summarizeScriptSpans } from "@/features/telemetry/scriptSpanSummary";

type SpanJson = NonNullable<Event["spans"]>[number];

function span(op: string, start: number, seconds: number, size?: number): SpanJson {
  return {
    op,
    description: `${op}@${start}`,
    span_id: `${op}-${start}`,
    trace_id: "t",
    start_timestamp: start,
    timestamp: start + seconds,
    status: "ok",
    data: size === undefined ? {} : { "http.response.size": size },
  };
}

function load(spans: SpanJson[]): Event {
  return {
    type: "transaction",
    transaction: "/",
    spans,
    contexts: { trace: { span_id: "root", trace_id: "t", op: "pageload", data: { "sentry.op": "pageload" } } },
  };
}

describe("script span summary", () => {
  it("keeps only the slowest script spans and counts the rest on the load", () => {
    // Thirty scripts, the n-th taking n milliseconds, starting 10 ms apart; one fetch and one stylesheet beside them.
    const scripts = Array.from({ length: 30 }, (_, n) => span("resource.script", 100 + n * 0.01, (n + 1) / 1000, 100));
    const others = [span("http.client", 100, 0.5), span("resource.css", 100, 0.001)];

    const summarized = summarizeScriptSpans(load([...scripts, ...others]));

    const kept = summarized.spans!.filter((s) => s.op === "resource.script");
    expect(kept).toHaveLength(KEPT_SCRIPT_SPANS);
    expect(kept.map((s) => s.span_id)).toEqual(scripts.slice(-KEPT_SCRIPT_SPANS).map((s) => s.span_id));
    expect(summarized.spans).toEqual(expect.arrayContaining(others));
    expect(summarized.contexts!.trace!.data).toEqual({
      "sentry.op": "pageload",
      "resource.script.count": 30,
      "resource.script.kept": KEPT_SCRIPT_SPANS,
      // The first starts at 100.00 and the last, starting at 100.29, takes 30 ms.
      "resource.script.wall_ms": 320,
      "resource.script.transfer_bytes": 3000,
    });
  });

  it("leaves a load with no more scripts than it would keep as it is", () => {
    const event = load(Array.from({ length: KEPT_SCRIPT_SPANS }, (_, n) => span("resource.script", 100 + n, 0.01)));
    expect(summarizeScriptSpans(event)).toBe(event);
  });

  it("leaves an error event as it is", () => {
    const error: Event = { type: undefined, message: "boom" };
    expect(summarizeScriptSpans(error)).toBe(error);
  });
});
