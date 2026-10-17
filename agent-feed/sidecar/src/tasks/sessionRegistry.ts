// Which running process, if any, owns a session.
//
// The harness keeps `~/.claude/sessions/<pid>.json` naming the session each live Claude process is
// serving. That file is the only bridge from a transcript on disk to the process running it, which
// is why background-task detection works for a session the panel found by reading files rather than
// by observing the network (ADR-0099), and why a session can be typed into at all (ADR-0107): the
// row names the process, and the process publishes both the shells and the inbox.
//
// A pid alone is not identity. The record carries `procStart` for exactly that reason, and this
// module refuses to trust a pid whose start time disagrees.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeSessionActivity, ClaudeSessionEntrypoint } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import type { ProcessRow } from "@/tasks/processProbe";
import { parseRegistryProcStart, startTimesAgree } from "@/tasks/processStartTime";

export interface ClaudeSessionProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Process start, epoch ms, as agreed by BOTH the registry and the kernel. */
  startedAt: number;
  /**
   * The session's cross-session message inbox, when this build publishes one.
   *
   * null is ordinary rather than exceptional: the inbox is gated, and a session started by an
   * older harness simply has no socket. Present here rather than in a second reader because
   * this is already the one module that decides which registry rows describe a LIVE process,
   * and a path taken from a row nobody verified is a path to some other session's inbox.
   */
  messagingSocketPath: string | null;
  /** How the session was launched. `cli` is a terminal; `claude-desktop` is an app window. */
  entrypoint: ClaudeSessionEntrypoint;
  /**
   * The tmux session this process is running inside, when it says so.
   *
   * The harness writes `tmux` as `<session>:@window.%pane` from 2.1.263; only the session name is
   * kept, because every tmux verb this repo issues addresses `-t <session>`. null for a build that
   * does not write it and for a process that is not under tmux at all, which are both ordinary.
   *
   * It is read HERE rather than by a second reader for the same reason `messagingSocketPath` is:
   * this is the one module that decides which registry rows describe a live process, and a session
   * name taken from an unverified row addresses some other session's pane.
   */
  tmuxSession: string | null;
  /**
   * Whether the process is blocked on the person at its terminal: a question dialog or a
   * permission prompt is standing in place of the prompt box.
   *
   * The harness writes `status: "waiting"` (with `waitingFor: "input needed"`) the moment a dialog
   * opens, measured 2026-10-14 on 2.1.296: the row's `statusUpdatedAt` landed three seconds after
   * the asking turn was cut off, while the transcript held nothing of that turn for as long as the
   * dialog stood. That makes it the one cheap, early signal that a session has a dialog the panel
   * may know nothing about. It says only THAT the process waits, not on what; the pane says what.
   */
  waiting: boolean;
  /** The row's `status` as the CLI wrote it, or null for a value this reader does not know. */
  activity: ClaudeSessionActivity | null;
  /** The CLI version the process is running, which only the row records. */
  version: string | null;
  /** The session's address, which is what its pane header and `ListAgents` show. */
  name: string | null;
}

const ACTIVITIES: readonly ClaudeSessionActivity[] = ["busy", "shell", "idle", "waiting"];

interface RegistryRecord {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  procStart?: unknown;
  messagingSocketPath?: unknown;
  entrypoint?: unknown;
  tmux?: unknown;
  status?: unknown;
  version?: unknown;
  name?: unknown;
}

/**
 * The launch surfaces we distinguish, with everything else collapsed.
 *
 * Unknown values become `other` rather than being rejected: a new entrypoint the harness invents
 * must not make a live session read as not running, and nothing downstream needs to name it.
 */
function readEntrypoint(value: unknown): ClaudeSessionEntrypoint {
  return value === "cli" || value === "sdk-cli" || value === "claude-desktop" ? value : "other";
}

/**
 * The session name out of the harness's `<session>:@window.%pane`.
 *
 * Validated to the same plain-identifier shape the terminal service demands, because this value
 * ends up as `-t <session>` on argument vectors this process builds, and a row is a file any
 * process running as this user could have written.
 */
export function readTmuxSession(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.split(":")[0] ?? "";
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : null;
}

/**
 * Every session with a live process behind it.
 *
 * Records for exited processes are left on disk, so this both checks liveness and verifies the
 * start time. A record that fails either check is skipped rather than raised: a stale file is the
 * normal state of that directory, not a fault.
 *
 * The kernel arrives as a TABLE rather than being asked per record. This used to fork
 * `ps -p <pid> -o lstart=` once for every file in the directory, which on this machine is 19 forks
 * and about 48 ms -- on every tick, of every subscribed session, so a wall of open sessions paid it
 * squared. `ProcessRow.startedAt` is the same `parseProcessLstart` of the same `lstart` field, so
 * the pid-reuse check below is unchanged; only where the number comes from moved.
 */
export async function liveSessionProcesses(
  table: readonly ProcessRow[],
  directory: string = config.claudeSessionsDirectory,
): Promise<ClaudeSessionProcess[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // No registry at all means no Claude has run on this machine yet. Not an error.
    return [];
  }
  const startedAtByPid = new Map(table.map((row) => [row.pid, row.startedAt]));
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
    const kernelStart = startedAtByPid.get(pid);
    // Absent means the process is gone, which is the ordinary state of half this directory. A
    // process that exists but whose start time `ps` printed in a shape we cannot read is absent
    // from the table too, and `processTable` is where that is said out loud -- it is a fact about
    // the whole table rather than about one session, and every consumer of it is affected.
    if (kernelStart === undefined) continue;
    if (!startTimesAgree(registryStart, kernelStart)) continue;
    live.push({
      pid,
      sessionId,
      cwd: typeof cwd === "string" ? cwd : "",
      startedAt: kernelStart,
      messagingSocketPath: typeof record.messagingSocketPath === "string" &&
          record.messagingSocketPath !== ""
        ? record.messagingSocketPath
        : null,
      entrypoint: readEntrypoint(record.entrypoint),
      tmuxSession: readTmuxSession(record.tmux),
      waiting: record.status === "waiting",
      activity: ACTIVITIES.find((activity) => activity === record.status) ?? null,
      version: typeof record.version === "string" && record.version !== "" ? record.version : null,
      name: typeof record.name === "string" && record.name !== "" ? record.name : null,
    });
  }
  return live;
}

/** The live process serving one session, or null when nothing is running it. */
export async function sessionOwner(
  sessionId: string,
  table: readonly ProcessRow[],
  directory?: string,
): Promise<ClaudeSessionProcess | null> {
  const live = await liveSessionProcesses(table, directory);
  return live.find((entry) => entry.sessionId === sessionId) ?? null;
}
