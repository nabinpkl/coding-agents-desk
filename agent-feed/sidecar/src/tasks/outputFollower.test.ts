import { describe, expect, test } from "bun:test";
import { lastLines, OutputProgress, snapshotOffset, trimPartialFirstLine } from "./outputFollower.ts";

describe("OutputProgress", () => {
  test("reports a growth rate per second from a sub-second sample", () => {
    const progress = new OutputProgress(1000, 0);
    expect(progress.observe(1050, 500)).toEqual({ bytes: 1050, bytesPerSecond: 100, idleMs: 0 });
  });

  test("a quiet tick reports idle time rather than hiding", () => {
    // The whole point of the panel: a wedged task and a finished one look identical unless the
    // idle clock is visible.
    const progress = new OutputProgress(1000, 0);
    progress.observe(1000, 2000);
    expect(progress.observe(1000, 6000)).toEqual({ bytes: 1000, bytesPerSecond: 0, idleMs: 6000 });
  });

  test("idle resets the moment the file grows again", () => {
    const progress = new OutputProgress(0, 0);
    progress.observe(0, 5000);
    expect(progress.observe(100, 6000)).toMatchObject({ idleMs: 0 });
  });

  test("a truncated file does not report the task running backwards", () => {
    // Log rotation mid-watch. A negative rate would render as a task un-writing its output.
    const progress = new OutputProgress(10_000, 0);
    const observed = progress.observe(20, 1000);
    expect(observed.bytesPerSecond).toBe(20);
    expect(observed.bytes).toBe(20);
  });

  test("two samples at the same instant do not divide by zero", () => {
    const progress = new OutputProgress(0, 1000);
    expect(progress.observe(500, 1000).bytesPerSecond).toBe(0);
  });
});

describe("snapshotOffset", () => {
  test("opens on the tail of a large log rather than its beginning", () => {
    // A 40 MB build log opened from zero would ship 40 MB to a phone before showing anything.
    expect(snapshotOffset(40_000_000, 64 * 1024)).toBe(40_000_000 - 64 * 1024);
  });

  test("a short file is shown whole", () => {
    expect(snapshotOffset(100, 64 * 1024)).toBe(0);
  });
});

describe("trimPartialFirstLine", () => {
  test("drops the half line a mid-file window starts on", () => {
    expect(trimPartialFirstLine("f line\nwhole line\n", false)).toBe("whole line\n");
  });

  test("keeps the first line when the window reached the start of the file", () => {
    expect(trimPartialFirstLine("whole line\n", true)).toBe("whole line\n");
  });

  test("a window with no break at all yields nothing rather than a fragment", () => {
    expect(trimPartialFirstLine("no break here", false)).toBe("");
  });
});

describe("lastLines", () => {
  test("keeps only the tail of a long log", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const kept = lastLines(text, 3);
    expect(kept).toBe("line 497\nline 498\nline 499");
  });

  test("a short log is returned untouched", () => {
    expect(lastLines("a\nb", 10)).toBe("a\nb");
  });
});
