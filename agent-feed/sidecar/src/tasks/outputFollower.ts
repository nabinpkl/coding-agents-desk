// Following a task's output the way `tail -f` does, and turning its growth into the two numbers
// that answer "is this thing moving".
//
// No full-file reads, ever. A `stat` gives the size, and only the bytes past the last offset are
// read. A build log that reaches 40 MB costs the same per tick as an empty one.

import type { BackgroundTaskProgress } from "@agentdesk/agent-feed-wire";

/**
 * Growth rate and idle time across successive observations.
 *
 * Deliberately reports rather than judges. There is no `stuck` here and there should not be: a
 * quiet `xcodebuild` writes nothing for minutes and then bursts, so a threshold would call it
 * wedged more often than it would be right. A viewer reads "idle 4s" against what they know the
 * command is doing, which no constant in this file can.
 */
export class OutputProgress {
  private lastSize: number;
  private lastSampleAt: number;
  private lastGrowthAt: number;

  constructor(size: number, now: number) {
    this.lastSize = size;
    this.lastSampleAt = now;
    this.lastGrowthAt = now;
  }

  observe(size: number, now: number): BackgroundTaskProgress {
    const elapsed = now - this.lastSampleAt;
    const grew = size - this.lastSize;
    // A file that shrank was truncated or replaced under us. Treat it as growth from zero rather
    // than reporting a negative rate, which would render as the task running backwards.
    const delta = grew < 0 ? size : grew;
    if (delta > 0) this.lastGrowthAt = now;
    const bytesPerSecond = elapsed > 0 ? (delta * 1000) / elapsed : 0;
    this.lastSize = size;
    this.lastSampleAt = now;
    return {
      bytes: size,
      bytesPerSecond: Math.max(0, Math.round(bytesPerSecond * 10) / 10),
      idleMs: Math.max(0, now - this.lastGrowthAt),
    };
  }
}

/**
 * Where a follower should start reading so the viewer opens on the end of the log rather than its
 * beginning, and never on a half line.
 *
 * A 40 MB build log opened from byte zero would ship 40 MB to a phone before showing anything
 * useful; the interesting part of a log you are watching is always its tail.
 */
export function snapshotOffset(size: number, windowBytes: number): number {
  return Math.max(0, size - windowBytes);
}

/**
 * Drop a leading partial line.
 *
 * A window into the middle of a file almost always starts mid-line, and half a line rendered as
 * the first row of the panel reads as corruption. Only applied when the window did not reach the
 * start of the file, where the first line really is a whole one.
 */
export function trimPartialFirstLine(text: string, fromStartOfFile: boolean): string {
  if (fromStartOfFile) return text;
  const firstBreak = text.indexOf("\n");
  return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
}

/** Keep the last `limit` lines, so opening a long log does not paste a megabyte into the DOM. */
export function lastLines(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  return lines.slice(lines.length - limit).join("\n");
}
