// A memory reading carries every figure `process.memoryUsage()` gives, under the names the archive
// reader (`tools/telemetry-replay.mjs memory`) prints.

import { expect, test } from "bun:test";
import { processMemoryAttributes } from "@/telemetry/sidecarMemory";

test("names each figure of a memory reading, and the uptime in whole seconds", () => {
  const usage = { rss: 300e6, heapUsed: 80e6, heapTotal: 120e6, external: 20e6, arrayBuffers: 5e6 };
  expect(processMemoryAttributes(usage, 3600.4)).toEqual({
    "process.memory.rss": 300e6,
    "process.memory.heap_used": 80e6,
    "process.memory.heap_total": 120e6,
    "process.memory.external": 20e6,
    "process.memory.array_buffers": 5e6,
    "process.uptime_s": 3600,
  });
});

test("this process's own reading is all numbers", () => {
  const attributes = processMemoryAttributes(process.memoryUsage(), process.uptime());
  for (const value of Object.values(attributes)) expect(Number.isFinite(value)).toBe(true);
  expect(attributes["process.memory.rss"]).toBeGreaterThan(0);
});
