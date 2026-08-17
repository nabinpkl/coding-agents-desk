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
import {
  parseProcessLstart,
  parseRegistryProcStart,
  startTimesAgree,
} from "./processStartTime.ts";

export interface ClaudeSessionProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Process start, epoch ms, as agreed by BOTH the registry and the kernel. */
  startedAt: number;
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
