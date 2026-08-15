// Which running process, if any, owns a session.
//
// The harness keeps `~/.claude/sessions/<pid>.json` naming the session each live Claude process is
// serving. That file is the only bridge from a transcript on disk to a process able to own
// background shells, and it is why background-task detection works for a session the panel found
// by reading files rather than by observing the network (ADR-0099).
//
// A pid alone is not identity. The record carries `procStart` for exactly that reason, and this
// module refuses to trust a pid whose start time disagrees.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import type { CommandRunner } from "./processProbe.ts";
import { PS_BINARY, runCommand } from "./processProbe.ts";

export interface ClaudeSessionProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Process start, epoch ms, as agreed by BOTH the registry and the kernel. */
  startedAt: number;
}

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
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
 * The registry's `procStart`, in epoch ms.
 *
 * **It is UTC, and it says so nowhere.** Measured against a live process: the registry reads
 * `Fri Aug 14 17:10:48 2026` for one that `ps` reports as `Fri Aug 14 13:10:48 2026` local, and
 * reading the registry value as UTC makes the two agree exactly. Parsing it as local time instead
 * would put every session five hours out and reject all of them, which fails silently as "no
 * background tasks anywhere".
 */
export function parseRegistryProcStart(text: string): number | null {
  const parts = parseCTime(text);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

/** `ps -o lstart=`, which unlike the registry really is local time. */
export function parseProcessLstart(text: string): number | null {
  const parts = parseCTime(text);
  if (!parts) return null;
  return new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
    .getTime();
}

/** Both sources round to whole seconds, so they agree exactly or the pid was reused. */
const START_TIME_TOLERANCE_MS = 2000;

export function startTimesAgree(registryMs: number, kernelMs: number): boolean {
  return Math.abs(registryMs - kernelMs) <= START_TIME_TOLERANCE_MS;
}

interface RegistryRecord {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  procStart?: unknown;
}

/**
 * Every session with a live process behind it.
 *
 * Records for exited processes are left on disk, so this both checks liveness and verifies the
 * start time. A record that fails either check is skipped rather than raised: a stale file is the
 * normal state of that directory, not a fault.
 */
export async function liveSessionProcesses(
  run: CommandRunner = runCommand,
  directory: string = config.claudeSessionsDirectory,
): Promise<ClaudeSessionProcess[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // No registry at all means no Claude has run on this machine yet. Not an error.
    return [];
  }
  const live: ClaudeSessionProcess[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: RegistryRecord;
    try {
      record = JSON.parse(await readFile(join(directory, name), "utf8")) as RegistryRecord;
    } catch {
      continue;
    }
    const { pid, sessionId, cwd, procStart } = record;
    if (typeof pid !== "number" || typeof sessionId !== "string" || typeof procStart !== "string") {
      continue;
    }
    const registryStart = parseRegistryProcStart(procStart);
    if (registryStart === null) continue;
    const lstart = (await run([PS_BINARY, "-p", String(pid), "-o", "lstart="])).trim();
    // Empty means the process is gone, which is the ordinary state of half this directory.
    if (!lstart) continue;
    const kernelStart = parseProcessLstart(lstart);
    if (kernelStart === null) {
      // The process EXISTS and we could not read when it started. That is a format we do not
      // understand, not a dead pid, and it silently rejects every session -- so it is said out
      // loud rather than counted as "nothing is running".
      console.error(JSON.stringify({
        event: "agent-feed-session-start-unparsed",
        pid,
        lstart: lstart.slice(0, 64),
      }));
      continue;
    }
    if (!startTimesAgree(registryStart, kernelStart)) continue;
    live.push({
      pid,
      sessionId,
      cwd: typeof cwd === "string" ? cwd : "",
      startedAt: kernelStart,
    });
  }
  return live;
}

/** The live process serving one session, or null when nothing is running it. */
export async function sessionOwner(
  sessionId: string,
  run: CommandRunner = runCommand,
  directory?: string,
): Promise<ClaudeSessionProcess | null> {
  const live = await liveSessionProcesses(run, directory);
  return live.find((entry) => entry.sessionId === sessionId) ?? null;
}
