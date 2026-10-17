// Closing the sessions nobody is using: off the canvas, idle, and quiet for a while.
//
// Every session the panel starts runs in a tmux pane of its own and stays there, which is the point
// -- it is there to be come back to -- until the reader stops coming back. Measured 2026-10-16 on
// this Mac: 19 Claude processes at about 100MB each, four of them in no Bot on the canvas and
// quiet for hours, one for 126. The canvas is where the owner keeps what they are working with, so
// a session that is not on it and has gone quiet is the one to close. Settled on the owner's word.
//
// Closing is not losing. The transcript stays, the session stays in every session list, and opening
// it again resumes it in a pane (`sessionPaneRevival.ts`, and the resume path behind it). What a
// close ends is the process, and only a process with nothing to lose: the harness's own registry
// says `idle`, the same test `staleClaudeSessions.ts` restarts by, read again just before each close
// because a message can start a turn in between.
//
// opencode is closed too, on its own evidence. Its pane holds a TUI that is only a client of the
// machine's one serve (it holds no database and talks to the serve over HTTP), so closing it never
// ends a turn: the serve runs those. Busy is still asked first, of the serve's
// `GET /api/session/active` ("Sessions absent from the result are inactive"), and a serve that
// cannot be asked leaves every opencode pane alone -- here the safe failure is to close nothing.
// The known gap: a TUI can switch to another session in a tab, and the stamp still names the one
// it was started for, which nothing on the serve or in tmux reports (checked 2026-10-16). A TUI
// moved onto a busy session can then be closed under its reader; the session keeps running in the
// serve and reopens where it was. Accepted on the owner's word.
//
// What is never closed, whatever its age:
// - a session on the canvas, or the Father home's session;
// - a pane this sidecar did not start (no `@agentdesk-session` stamp): a tmux session somebody made
//   by hand, the tab bar's machine shell;
// - a pane somebody is attached to, or one holding more than the agent (a second window or pane);
// - a pane whose agent has already exited, or runs somewhere else (a Desktop window, another pane):
//   only a pane with the idle Claude process, or the opencode TUI, inside it is closed, since one
//   without may be running something else now.
//
// Idle is measured from the session's last timestamped record, which the catalog already keeps
// (`lastEventAt`). Not from tmux, which counts keystrokes into the pane and showed this very
// session idle for 337 hours while it worked, and not from the transcript's modified time, which
// the CLI moves whenever it rewrites its title.
//
// A timer, because nothing announces that time has passed. It sends `kill-session`, which
// `tmuxAttachment.ts` forbids a VIEWER and allows the owner: this is the owner's standing request,
// and every close is logged with the session and why.

import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { BotStore } from "@/bots/botStore";
import { idleCloseAfterMs, idleSweepEveryMs } from "@/config/configRecency";
import { currentProcessTable } from "@/tasks/processProbe";
import { liveSessionProcesses } from "@/tasks/sessionRegistry";
import { killTmuxSession } from "@/terminal/tmux/tmuxSessionList";
import { findSession } from "@/transcripts/catalog/catalogState";
import { serveGet } from "@/agents/opencode/opencodeClient";
import { sessionActivity } from "@/terminal/session-panes/staleClaudeSessions";
import { noServerRunning, tmux } from "@/terminal/tmux/tmuxCommand";
import type { ClaudeSessionProcess } from "@/tasks/sessionRegistry";

/** One tmux pane, as far as the sweep cares: whose it is and whether anybody is in it. */
export interface SweepPane {
  /** The tmux session's name. */
  session: string;
  /** The session id this sidecar stamped on it, or empty for a session it did not start. */
  stamp: string;
  attached: number;
  /** The pane's own process, which the agent is or runs under. */
  pid: number;
}

/** The live Claude processes, the opencode TUIs, and every process's parent, from one process table. */
export interface SweepProcesses {
  live: readonly ClaudeSessionProcess[];
  /** Every running `opencode` that is not the serve: the TUIs a pane can hold. */
  opencodeTuis: readonly number[];
  parentOf: ReadonlyMap<number, number>;
}

export type SweepSource = "claude" | "opencode";

export interface IdleSweepSources {
  /** Live Claude processes the harness registry and the kernel agree on, with the process tree. */
  processes(): Promise<SweepProcesses>;
  /** Every pane tmux has, one entry per pane. */
  panes(): Promise<readonly SweepPane[]>;
  /** When the session last wrote a timestamped record, or null when the catalog has not read it. */
  lastEventAt(source: SweepSource, sessionId: string): number | null;
  /** The opencode sessions with a turn running, or null when the serve could not be asked. */
  activeOpencode(): Promise<ReadonlySet<string> | null>;
  bots(): Promise<readonly BotRecord[]>;
  close(session: string): Promise<void>;
  now(): number;
  log(message: string): void;
}

/** A pane the sweep would close, and how long its session has been quiet. */
export interface IdleCandidate {
  source: SweepSource;
  session: string;
  sessionId: string;
  idleMs: number;
}

/** The Claude sessions a Bot holds on the canvas, and every Father session. */
export function keptSessions(bots: readonly BotRecord[]): Set<string> {
  const kept = new Set<string>();
  for (const bot of bots) {
    if (bot.fatherSession) kept.add(bot.fatherSession.sessionId);
    if (bot.offCanvas) continue;
    const off = new Set((bot.offCanvasSessionRefs ?? []).map((ref) => `${ref.source}:${ref.sessionId}`));
    for (const ref of bot.sessionRefs) {
      if (!off.has(`${ref.source}:${ref.sessionId}`)) kept.add(ref.sessionId);
    }
  }
  return kept;
}

/**
 * Which panes may be closed now. Pure, so every rule above is tested without tmux or a registry.
 */
export function idleCandidates(input: {
  panes: readonly SweepPane[];
  processes: SweepProcesses;
  kept: ReadonlySet<string>;
  lastEventAt: (source: SweepSource, sessionId: string) => number | null;
  /** The opencode sessions with a turn running; null closes no opencode pane at all. */
  activeOpencode: ReadonlySet<string> | null;
  now: number;
  idleAfterMs: number;
}): IdleCandidate[] {
  const { parentOf } = input.processes;
  const panesPerSession = new Map<string, SweepPane[]>();
  for (const pane of input.panes) {
    panesPerSession.set(pane.session, [...panesPerSession.get(pane.session) ?? [], pane]);
  }
  const candidates: IdleCandidate[] = [];
  for (const [session, panes] of panesPerSession) {
    const [pane] = panes;
    if (!pane?.stamp || panes.length > 1 || pane.attached > 0) continue;
    const sessionId = pane.stamp;
    if (input.kept.has(sessionId)) continue;
    const processes = input.processes.live.filter((process) => process.sessionId === sessionId);
    let source: SweepSource;
    if (processes.length > 0) {
      // Claude: its process must be in THIS pane, not in a Desktop window or another pane. Idle is
      // asked of every process the session has, anywhere.
      if (!processes.some((process) => runsUnder(process.pid, pane.pid, parentOf))) continue;
      if (sessionActivity(processes) !== "idle") continue;
      source = "claude";
    } else {
      // opencode, or a Claude pane whose agent has exited: only a TUI in this pane, for a session
      // the serve says is not running, is closed.
      if (input.activeOpencode === null || input.activeOpencode.has(sessionId)) continue;
      if (!input.processes.opencodeTuis.some((pid) => runsUnder(pid, pane.pid, parentOf))) continue;
      source = "opencode";
    }
    const last = input.lastEventAt(source, sessionId);
    if (last === null) continue;
    const idleMs = input.now - last;
    if (idleMs >= input.idleAfterMs) candidates.push({ source, session, sessionId, idleMs });
  }
  return candidates;
}

/** Whether `pid` is `ancestor` or a descendant of it. */
function runsUnder(pid: number, ancestor: number, parentOf: ReadonlyMap<number, number>): boolean {
  for (let current: number | undefined = pid, steps = 0; current !== undefined && steps < 64; steps += 1) {
    if (current === ancestor) return true;
    current = parentOf.get(current);
  }
  return false;
}

/** Closes what `idleCandidates` names, each one checked again just before. Returns what it closed. */
export async function sweepIdleSessions(sources: IdleSweepSources, idleAfterMs: number): Promise<IdleCandidate[]> {
  const [panes, processes, bots, activeOpencode] = await Promise.all([
    sources.panes(),
    sources.processes(),
    sources.bots(),
    sources.activeOpencode(),
  ]);
  if (activeOpencode === null && panes.some((pane) => pane.stamp.startsWith("ses_"))) {
    sources.log("could not ask the opencode serve which sessions are running; leaving its panes");
  }
  const candidates = idleCandidates({
    panes,
    processes,
    kept: keptSessions(bots),
    lastEventAt: (source, sessionId) => sources.lastEventAt(source, sessionId),
    activeOpencode,
    now: sources.now(),
    idleAfterMs,
  });
  // Asked again once candidates exist, for the same reason the Claude state is re-read below.
  const runningOpencode = candidates.some((candidate) => candidate.source === "opencode")
    ? await sources.activeOpencode()
    : activeOpencode;
  const closed: IdleCandidate[] = [];
  for (const candidate of candidates) {
    // A message can arrive while the sweep is reading the rest: closing on the old answer would end
    // the turn it started.
    if (candidate.source === "claude") {
      const now = (await sources.processes()).live.filter((process) => process.sessionId === candidate.sessionId);
      if (sessionActivity(now) !== "idle") continue;
    } else if (runningOpencode === null || runningOpencode.has(candidate.sessionId)) {
      continue;
    }
    try {
      await sources.close(candidate.session);
      closed.push(candidate);
      const hours = (candidate.idleMs / 3_600_000).toFixed(1);
      sources.log(`closed idle ${candidate.source} session ${candidate.sessionId} (tmux "${candidate.session}"): off the canvas, quiet for ${hours}h`);
    } catch (error) {
      sources.log(`could not close idle session ${candidate.sessionId} (tmux "${candidate.session}"): ${String(error)}`);
    }
  }
  return closed;
}

/** Every pane tmux has, with the stamp and attached count of the session it is in. */
export async function listSweepPanes(): Promise<SweepPane[]> {
  const { out, err, code } = await tmux(["list-panes", "-a", "-F", "#{session_name}|#{@agentdesk-session}|#{session_attached}|#{pane_pid}"]);
  if (code !== 0) {
    if (noServerRunning(err)) return [];
    throw new Error(`tmux list-panes exited ${code}: ${err.trim() || out.trim()}`);
  }
  return out.split("\n").filter((line) => line.trim()).flatMap((line) => {
    const [session, stamp, attached, pid] = line.split("|");
    return session ? [{ session, stamp: stamp?.trim() ?? "", attached: Number(attached) || 0, pid: Number(pid) || -1 }] : [];
  });
}

/**
 * How soon after the sidecar starts the first sweep runs. Not a whole interval: the live sidecar is
 * replaced on every edit, often several times an hour, and a sweep that waited an hour from each
 * start would never run on a working day. Soon is safe because idle is measured from the
 * transcript, not from how long this process has been up; a minute gives the catalog its first read.
 */
const FIRST_SWEEP_MS = 60_000;

/** Sweeps on a timer for the life of the process. 0 for `idleAfterMs` sweeps nothing. */
export function startIdleSessionSweep(sources: IdleSweepSources, idleAfterMs: number, everyMs: number): () => void {
  if (idleAfterMs <= 0) return () => {};
  let running = false;
  const sweep = () => {
    if (running) return;
    running = true;
    sweepIdleSessions(sources, idleAfterMs)
      .catch((error: unknown) => sources.log(`idle sweep failed: ${String(error)}`))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(sweep, Math.min(FIRST_SWEEP_MS, everyMs));
  const timer = setInterval(sweep, everyMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** An `opencode` process that is not the serve: `opencode`, or `opencode --session <id>`. */
const OPENCODE_TUI = /^(\S*\/)?opencode(?!\s+serve\b)(\s|$)/;

/** The sessions the serve is running a turn for, or null when it could not be asked. */
async function activeOpencode(): Promise<ReadonlySet<string> | null> {
  try {
    const answer = await serveGet("/api/session/active");
    if (answer.status !== 200) return null;
    const data = (JSON.parse(answer.text) as { data?: unknown } | null)?.data;
    return data !== null && typeof data === "object" ? new Set(Object.keys(data)) : null;
  } catch {
    return null;
  }
}

/** The sweep over this machine, as `server.ts` starts it. Logged to the sidecar's own log. */
export function startLiveIdleSessionSweep(botStore: Pick<BotStore, "snapshot">): () => void {
  return startIdleSessionSweep({
    processes: async () => {
      const table = await currentProcessTable();
      return {
        live: await liveSessionProcesses(table),
        opencodeTuis: table.filter((row) => OPENCODE_TUI.test(row.command)).map((row) => row.pid),
        parentOf: new Map(table.map((row) => [row.pid, row.ppid])),
      };
    },
    panes: listSweepPanes,
    lastEventAt: (source, sessionId) => findSession(source, sessionId)?.lastEventAt ?? null,
    activeOpencode,
    bots: async () => (await botStore.snapshot()).bots,
    close: killTmuxSession,
    now: Date.now,
    log: (message) => console.log(`[idle-sweep] ${message}`),
  }, idleCloseAfterMs, idleSweepEveryMs);
}
