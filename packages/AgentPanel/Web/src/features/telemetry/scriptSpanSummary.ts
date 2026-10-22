// A page load's script fetches, kept as a summary and the slowest few rather than one span each.
//
// The dev server serves every module as its own file, so a load fetches about 380 scripts and the
// SDK records a span per fetch. Measured 2026-10-21 over 101 loads, those spans were 87% of the
// telemetry archive (58.7 of 67.6 MB), which kept two weeks of loads where the same cap holds
// months without them. What a slow load needs from them is how many there were, how long they
// took together, and which few held it up: those stay as spans, in place in the trace, and the
// rest are counted on the load itself.

import type { Event } from "@sentry/react";

/** How many script fetches keep their own span: the longest, which are what a slow load waited on. */
export const KEPT_SCRIPT_SPANS = 10;

const SCRIPT_OP = "resource.script";

type SpanJson = NonNullable<Event["spans"]>[number];

function seconds(span: SpanJson): number {
  return (span.timestamp ?? span.start_timestamp) - span.start_timestamp;
}

/**
 * Drops all but the longest script spans from a transaction and records on its own trace data
 * how many there were, the time from the first fetch starting to the last one ending, and the
 * bytes they transferred. Anything that is not a transaction with more than that many passes as is.
 */
export function summarizeScriptSpans(event: Event): Event {
  if (event.type !== "transaction" || !event.spans || !event.contexts?.trace) return event;
  const scripts = event.spans.filter((span) => span.op === SCRIPT_OP);
  if (scripts.length <= KEPT_SCRIPT_SPANS) return event;

  const kept = new Set([...scripts].sort((a, b) => seconds(b) - seconds(a)).slice(0, KEPT_SCRIPT_SPANS));
  const firstStart = Math.min(...scripts.map((span) => span.start_timestamp));
  const lastEnd = Math.max(...scripts.map((span) => span.timestamp ?? span.start_timestamp));
  const transferBytes = scripts.reduce((sum, span) => {
    const size = span.data["http.response.size"];
    return sum + (typeof size === "number" ? size : 0);
  }, 0);

  const trace = event.contexts.trace;
  return {
    ...event,
    spans: event.spans.filter((span) => span.op !== SCRIPT_OP || kept.has(span)),
    contexts: {
      ...event.contexts,
      trace: {
        ...trace,
        data: {
          ...trace.data,
          "resource.script.count": scripts.length,
          "resource.script.kept": KEPT_SCRIPT_SPANS,
          "resource.script.wall_ms": Math.round((lastEnd - firstStart) * 1000),
          "resource.script.transfer_bytes": transferBytes,
        },
      },
    },
  };
}
