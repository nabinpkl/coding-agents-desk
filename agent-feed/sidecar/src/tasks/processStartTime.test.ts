import { describe, expect, test } from "bun:test";
import {
  parseProcessLstart,
  parseRegistryProcStart,
  startTimesAgree,
} from "./processStartTime.ts";

describe("proc start parsing", () => {
  test("the registry stamp is UTC even though it carries no marker", () => {
    // Measured against a live process: the registry read `Fri Aug 14 17:10:48 2026` for one the
    // kernel reported as `13:10:48` local. Reading it as local time puts every session hours out
    // and rejects all of them, which shows up as "no background tasks anywhere".
    expect(parseRegistryProcStart("Fri Aug 14 17:10:48 2026")).toBe(Date.UTC(2026, 7, 14, 17, 10, 48));
  });

  test("ps lstart really is local time", () => {
    expect(parseProcessLstart("Fri Aug 14 13:10:48 2026")).toBe(
      new Date(2026, 7, 14, 13, 10, 48).getTime(),
    );
  });

  test("a day-before-month locale still parses", () => {
    // The Mac host inherits LANG=en_CA.UTF-8, under which `ps -o lstart=` prints
    // `Fri 14 Aug 13:10:48 2026`. Reading position 2 as the month yielded null for every process,
    // so every session looked like a pid mismatch and the panel reported no background work.
    expect(parseProcessLstart("Fri 14 Aug 13:10:48 2026")).toBe(
      new Date(2026, 7, 14, 13, 10, 48).getTime(),
    );
    expect(parseProcessLstart("Fri Aug 14 13:10:48 2026")).toBe(
      parseProcessLstart("Fri 14 Aug 13:10:48 2026"),
    );
  });

  test("a single-digit day padded by ps still parses", () => {
    // `Mon Aug  3 16:42:02 2026` -- two spaces, seen on a real record.
    expect(parseProcessLstart("Mon Aug  3 16:42:02 2026")).toBe(
      new Date(2026, 7, 3, 16, 42, 2).getTime(),
    );
  });

  test("garbage is null rather than an Invalid Date that compares false everywhere", () => {
    expect(parseRegistryProcStart("")).toBeNull();
    expect(parseRegistryProcStart("yesterday")).toBeNull();
    expect(parseProcessLstart("Fri Xxx 14 13:10:48 2026")).toBeNull();
  });

  test("whole-second rounding on both sides still agrees", () => {
    const base = Date.UTC(2026, 7, 14, 17, 10, 48);
    expect(startTimesAgree(base, base)).toBe(true);
    expect(startTimesAgree(base, base + 1000)).toBe(true);
    expect(startTimesAgree(base, base + 60_000)).toBe(false);
  });
});
