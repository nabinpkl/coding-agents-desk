// When a process started, from the clocks this feature reads.
//
// Its own module because there are two consumers with nothing else in common: the session registry
// checks a pid's start against the harness's record to defeat pid reuse, and the task probe asks a
// live shell how long it has been running. One parser, one set of scars.
//
// THREE shapes reach it, not two, and each fails silently in its own way. `ps -o lstart=` is ctime
// in local time. The registry's `procStart` is ctime in UTC on a Mac -- and on Linux it is not a
// date at all, but `/proc/<pid>/stat` starttime in clock ticks since boot, which the ctime parser
// reads as garbage. That third shape is why this module grew a platform branch; the scar is under
// `parseRegistryProcStart`.

import { readFileSync } from "node:fs";

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

interface CTimeParts {
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  year: number;
}

/**
 * Split a ctime-style stamp: `Fri Aug 14 17:10:48 2026`.
 *
 * Whitespace-tolerant because `ps` pads single-digit days to a fixed width, so a first-of-month
 * process reads `Mon Aug  3 16:42:02 2026` with two spaces.
 *
 * The month is found by NAME rather than by position, because position is not stable: `ps` formats
 * `lstart` per locale, and under `en_CA` it emits `Fri 14 Aug 13:10:48 2026` with the day first.
 * The probe now forces `LC_ALL=C` so this should always see the American order, but a parser that
 * cannot be broken by word order is three lines, and the failure it prevents is silent -- every
 * session read as a pid mismatch, and a panel that reports no background work at all.
 */
function parseCTime(text: string): CTimeParts | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, second, third, clock, yearText] = parts;
  const monthFirst = MONTHS[second ?? ""] !== undefined;
  const month = monthFirst ? MONTHS[second ?? ""] : MONTHS[third ?? ""];
  const dayText = monthFirst ? third : second;
  const time = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(clock ?? "");
  if (month === undefined || !time) return null;
  const day = Number(dayText);
  const year = Number(yearText);
  if (!Number.isInteger(day) || !Number.isInteger(year)) return null;
  return {
    month,
    day,
    hour: Number(time[1]),
    minute: Number(time[2]),
    second: Number(time[3]),
    year,
  };
}

/**
 * The userspace tick the `/proc` ABI counts `starttime` in.
 *
 * A constant of that interface rather than a property of this machine: the kernel's own HZ is a
 * build option, but what `/proc/<pid>/stat` reports to userspace is fixed at 100. Confirmed on the
 * peer this was found on, where `getconf CLK_TCK` is 100 and the reconstruction below lands within
 * 0.6s of what `ps` says.
 */
const USER_HZ = 100;

/** Read once and kept: `btime` cannot change without the machine rebooting, and us with it. */
let bootTime: number | null | undefined;
let bootTimeSaid = false;

/**
 * When this machine booted, in epoch ms, or null where there is no `/proc` to ask.
 *
 * Only ever called for a value already known to be Linux-shaped, so a Mac never opens this file.
 */
export function linuxBootTimeMs(read: () => string = () => readFileSync("/proc/stat", "utf8")): number | null {
  if (bootTime !== undefined) return bootTime;
  try {
    const seconds = /^btime\s+(\d+)$/m.exec(read())?.[1];
    bootTime = seconds === undefined ? null : Number(seconds) * 1000;
  } catch {
    bootTime = null;
  }
  return bootTime;
}

/** Drops the cached boot time, so one test's machine is never another's. */
export function resetBootTimeCache(): void {
  bootTime = undefined;
  bootTimeSaid = false;
}

/**
 * The registry's `procStart`, in epoch ms, in whichever of its two shapes arrived.
 *
 * **On a Mac it is ctime in UTC, and it says so nowhere.** Measured against a live process: the
 * registry reads `Fri Aug 14 17:10:48 2026` for one that `ps` reports as `Fri Aug 14 13:10:48
 * 2026` local, and reading the registry value as UTC makes the two agree exactly. Parsing it as
 * local time instead would put every session five hours out and reject all of them, which fails
 * silently as "no background tasks anywhere".
 *
 * **On Linux it is `/proc/<pid>/stat` starttime: clock ticks since boot, as a bare number.** That
 * shape has one token where ctime has five, so the parser below returned null for every record on
 * a Linux peer, `liveSessionProcesses` answered with an empty list, and everything built on it
 * went quiet at once -- background tasks, the cross-session inbox's owner lookup, and the pane
 * resolution that `liveTmuxSession` falls back on when a tmux session carries no identity stamp.
 * Measured 2026-09-17 on the `oracle` peer: an image dropped onto a canvas card reached that
 * machine, was written to disk, and was never pasted into the pane, because the drop could not
 * find one. `btime 1786789416` plus `275826256 / 100` reconstructs `Wed Sep 16 08:34:38`, which is
 * what `ps` reports for that session to the second.
 *
 * `bootMs` is a parameter so a test needs no `/proc`, and undefined rather than null means "ask
 * this machine": null is a real answer, and it means there was nothing to ask.
 */
export function parseRegistryProcStart(text: string, bootMs?: number | null): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    const boot = bootMs === undefined ? linuxBootTimeMs() : bootMs;
    if (boot === null) {
      // Said out loud once, for the reason the process-table canary next door is: a record skipped
      // here is indistinguishable from a session that is not running, which is the exact silence
      // that hid this bug. Once per process, because it would otherwise fire per record per tick.
      if (!bootTimeSaid) {
        bootTimeSaid = true;
        console.error(
          JSON.stringify({
            event: "agent-feed-proc-start-no-boot-time",
            sample: trimmed.slice(0, 40),
          }),
        );
      }
      return null;
    }
    return boot + Math.round((Number(trimmed) * 1000) / USER_HZ);
  }
  const parts = parseCTime(trimmed);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

/** `ps -o lstart=`, which unlike the registry really is local time. */
export function parseProcessLstart(text: string): number | null {
  const parts = parseCTime(text);
  if (!parts) return null;
  return new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second).getTime();
}

/** Both sources round to whole seconds, so they agree exactly or the pid was reused. */
const START_TIME_TOLERANCE_MS = 2000;

export function startTimesAgree(registryMs: number, kernelMs: number): boolean {
  return Math.abs(registryMs - kernelMs) <= START_TIME_TOLERANCE_MS;
}
