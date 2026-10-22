// How much this process holds, recorded every five minutes as a span of its own in the telemetry
// archive, so a sidecar that has run for a day shows whether it grew and in which part: its whole
// footprint (`rss`), the JavaScript heap, or memory held outside it (buffers, a stream's queued
// bytes).
//
// Its own trace, which `tracesSampler` in `sidecarTelemetry.ts` keeps by this span's name.

import * as Sentry from "@sentry/bun";

export const MEMORY_SPAN = "sidecar memory";

/**
 * A poll, because nothing announces that memory changed. Five minutes resolves a leak over hours
 * and costs the archive about three hundred small envelopes a day.
 */
const SAMPLE_INTERVAL_MS = 5 * 60_000;

/** `process.memoryUsage()`, in bytes, under the names the archive reader prints. */
export function processMemoryAttributes(usage: NodeJS.MemoryUsage, uptimeSeconds: number): Record<string, number> {
  return {
    "process.memory.rss": usage.rss,
    "process.memory.heap_used": usage.heapUsed,
    "process.memory.heap_total": usage.heapTotal,
    "process.memory.external": usage.external,
    "process.memory.array_buffers": usage.arrayBuffers,
    "process.uptime_s": Math.round(uptimeSeconds),
  };
}

function recordProcessMemory(): void {
  Sentry.startNewTrace(() => {
    Sentry.startInactiveSpan({
      name: MEMORY_SPAN,
      op: "app.memory",
      attributes: processMemoryAttributes(process.memoryUsage(), process.uptime()),
    }).end();
  });
}

/** Once the server listens. Unref'd, so a test that starts the server is not held open by it. */
export function startProcessMemorySamples(): void {
  recordProcessMemory();
  setInterval(recordProcessMemory, SAMPLE_INTERVAL_MS).unref();
}
