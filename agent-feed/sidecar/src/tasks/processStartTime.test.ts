import { describe, expect, test } from "bun:test";
import {
  linuxBootTimeMs,
  parseProcessLstart,
  parseRegistryProcStart,
  resetBootTimeCache,
  startTimesAgree,
} from "@/tasks/processStartTime";

describe("proc start parsing", () => {
  test("the registry stamp is UTC even though it carries no marker", () => {
    // Measured against a live process: the registry read `Fri Aug 14 17:10:48 2026` for one the
    // kernel reported as `13:10:48` local. Reading it as local time puts every session hours out
    // and rejects all of them, which shows up as "no background tasks anywhere".
    expect(parseRegistryProcStart("Fri Aug 14 17:10:48 2026")).toBe(Date.UTC(2026, 7, 14, 17, 10, 48));
  });

  test("ps lstart really is local time", () => {
    expect(parseProcessLstart("Fri Aug 14 13:10:48 2026")).toBe(new Date(2026, 7, 14, 13, 10, 48).getTime());
  });

  test("a day-before-month locale still parses", () => {
    // The Mac host inherits LANG=en_CA.UTF-8, under which `ps -o lstart=` prints
    // `Fri 14 Aug 13:10:48 2026`. Reading position 2 as the month yielded null for every process,
    // so every session looked like a pid mismatch and the panel reported no background work.
    expect(parseProcessLstart("Fri 14 Aug 13:10:48 2026")).toBe(new Date(2026, 7, 14, 13, 10, 48).getTime());
    expect(parseProcessLstart("Fri Aug 14 13:10:48 2026")).toBe(parseProcessLstart("Fri 14 Aug 13:10:48 2026"));
  });

  test("a single-digit day padded by ps still parses", () => {
    // `Mon Aug  3 16:42:02 2026` -- two spaces, seen on a real record.
    expect(parseProcessLstart("Mon Aug  3 16:42:02 2026")).toBe(new Date(2026, 7, 3, 16, 42, 2).getTime());
  });

  test("garbage is null rather than an Invalid Date that compares false everywhere", () => {
    expect(parseRegistryProcStart("")).toBeNull();
    expect(parseRegistryProcStart("yesterday")).toBeNull();
    expect(parseProcessLstart("Fri Xxx 14 13:10:48 2026")).toBeNull();
  });

  test("a Linux registry stamp is ticks since boot, not a date", () => {
    // The real pair, measured 2026-09-17 on the `oracle` peer: `procStart` 275826256 for a session
    // `ps` reports as `Wed Sep 16 08:34:38 2026`, with `btime` 1786789416. Before this, the ctime
    // parser read that one token as garbage and every record on that machine was skipped -- which
    // took background tasks, the cross-session inbox and unstamped pane resolution with it.
    const registry = parseRegistryProcStart("275826256", 1786789416 * 1000);
    expect(registry).not.toBeNull();
    expect(startTimesAgree(registry!, parseProcessLstart("Wed Sep 16 08:34:38 2026")!)).toBe(true);
  });

  test("ticks with no boot time to add them to is null, not an epoch in 1970", () => {
    // Every other answer is worse than none: 275826256 ms of its own is March 1970, which passes
    // no agreement check but claims to be an answer.
    expect(parseRegistryProcStart("275826256", null)).toBeNull();
  });

  test("boot time comes off /proc/stat, and its absence is an answer", () => {
    resetBootTimeCache();
    expect(linuxBootTimeMs(() => "cpu  1 2 3\nbtime 1786789416\nprocesses 99\n")).toBe(1786789416 * 1000);
    resetBootTimeCache();
    // A Mac has no such file, and the throw is the ordinary case rather than a fault.
    expect(
      linuxBootTimeMs(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    resetBootTimeCache();
    expect(linuxBootTimeMs(() => "cpu  1 2 3\nprocesses 99\n")).toBeNull();
    resetBootTimeCache();
  });

  test("whole-second rounding on both sides still agrees", () => {
    const base = Date.UTC(2026, 7, 14, 17, 10, 48);
    expect(startTimesAgree(base, base)).toBe(true);
    expect(startTimesAgree(base, base + 1000)).toBe(true);
    expect(startTimesAgree(base, base + 60_000)).toBe(false);
  });
});
