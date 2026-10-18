import type {
  DesktopAuditSnapshot,
  WindowInputReason,
  WindowResolution,
  WindowTarget,
} from "@agentdesk/agent-feed-wire";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "@/config/config";

/**
 * Resolves a Claude session id to the Claude Desktop window that owns it.
 *
 * The mapping is the process tree, not window titles or content. Claude Desktop runs a RESUMED
 * coding session as a child Claude Code CLI whose argv carries `--resume=<sessionId>`, the same id
 * that names the transcript file, so walking that child's parents up to the Claude.app main binary
 * identifies the owning window process exactly. A brand-new session never carries its id in argv and
 * is resolved from Claude Code's per-pid registry instead. The AX tree exposes no session id, URL,
 * or document identity, so there is no second window-based source and none is attempted.
 *
 * Nothing here is native. It is `/bin/ps` output, a JSON directory, and a filter over a snapshot --
 * which is why it lives in the sidecar now: a targeting fix used to cost a Release host build, a
 * relaunch, and a re-attach of every surface, and now costs a `bun --watch` reload.
 *
 * Parsing and classification are pure and take the process table as a value, so every case --
 * Desktop child, terminal-only chain, absent session, prefix collision -- is testable against
 * fixture `ps` output with no live process tree.
 */

/** One row of the live process table, reduced to what resolution needs. */
export interface ProcessRow {
  pid: number;
  parentPid: number;
  arguments: string;
}

/**
 * How one resuming process relates to a Claude Desktop window.
 *
 * The same session id can legitimately appear more than once: a human can resume a transcript in a
 * terminal while its Desktop window is also open. Each resuming process is classified on its own
 * chain, and a Desktop match beats a terminal one, because only a window has a composer.
 */
export type SessionChain =
  | { kind: "desktop"; resumePid: number; claudeMainPid: number; executables: string[] }
  | { kind: "terminal"; resumePid: number; executables: string[] };

/** Longest parent chain walked before giving up. Real chains are three or four deep; the bound
 *  exists so a cycle in a malformed table cannot spin. */
export const MAX_CHAIN_DEPTH = 16;

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ").filter((field) => field.length > 0);
    if (fields.length < 3) continue;
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    // Rejoining rather than slicing the original line keeps this independent of how many spaces
    // `ps` used to pad its numeric columns.
    const args = fields.slice(2).join(" ");
    if (args.length === 0) continue;
    rows.push({ pid, parentPid, arguments: args });
  }
  return rows;
}

/**
 * Every session id this process resumes, in both live argv spellings.
 *
 * `--resume=<id>` is what Claude Desktop's embedded CLI passes; `--resume <id>` is what a terminal
 * session passes. Both are read here so a terminal session is FOUND and then classified as
 * terminal, rather than going unseen and reporting as not running.
 *
 * Ids are taken as whole tokens, never by substring. A containment test makes any session id that
 * is a prefix of another resolve to the wrong window, and session ids are opaque, so nothing
 * downstream would catch it.
 */
export function resumedSessionIds(args: string, flag: string): Set<string> {
  const found = new Set<string>();
  if (flag.length === 0) return found;
  const tokens = args.split(" ").filter((token) => token.length > 0);
  for (const [index, token] of tokens.entries()) {
    if (token === flag) {
      // `--resume <id>`: the value is the next token, unless the flag ends the line.
      const value = tokens[index + 1];
      if (value !== undefined) found.add(value);
    } else if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      if (value.length > 0) found.add(value);
    }
  }
  return found;
}

/** Every process resuming exactly this session, lowest pid first. */
export function resumePids(sessionId: string, rows: ProcessRow[], flag: string): number[] {
  return rows
    .filter((row) => resumedSessionIds(row.arguments, flag).has(sessionId))
    .map((row) => row.pid)
    .sort((a, b) => a - b);
}

export function chain(resumePid: number, rows: ProcessRow[], claudeMainPath: string): SessionChain {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) if (!byPid.has(row.pid)) byPid.set(row.pid, row);

  const executables: string[] = [];
  const visited = new Set<number>();
  let current = resumePid;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    const row = byPid.get(current);
    if (!row) break;
    executables.push(row.arguments.split(" ")[0] ?? "?");
    // Whole-token match rather than a bare prefix, so a sibling binary like `.../MacOS/ClaudeX` is
    // not read as the main process. This cannot disambiguate a path that legitimately contains a
    // space from an argument boundary -- argv arrives as one flat string -- but Claude's helpers
    // live under `Contents/Frameworks/`, and a wrong pid here degrades to `no-window` at targeting
    // rather than to a write against the wrong window.
    if (row.arguments === claudeMainPath || row.arguments.startsWith(`${claudeMainPath} `)) {
      return { kind: "desktop", resumePid, claudeMainPid: current, executables };
    }
    if (row.parentPid <= 1) break;
    current = row.parentPid;
  }
  return { kind: "terminal", resumePid, executables };
}

/** Everything the process tree can say about one session id, before windows are consulted. */
export interface SessionResolution {
  sessionId: string;
  chains: SessionChain[];
}

export function resolve(
  sessionId: string,
  rows: ProcessRow[],
  claudeMainPath: string = config.claudeDesktopMainPath,
  flag: string = config.claudeResumeFlag,
): SessionResolution {
  return {
    sessionId,
    chains: resumePids(sessionId, rows, flag).map((pid) => chain(pid, rows, claudeMainPath)),
  };
}

/**
 * Every DISTINCT Claude Desktop process holding this session, ascending.
 *
 * Distinct, because one instance legitimately produces several chains for one session -- a terminal
 * resume alongside the Desktop one, or a respawned child -- and those all address the same window.
 * More than one pid is the different case: separate app instances, separate windows, separate
 * Desktops.
 */
export function claudeMainPids(resolution: SessionResolution): number[] {
  const pids = new Set<number>();
  for (const link of resolution.chains) if (link.kind === "desktop") pids.add(link.claudeMainPid);
  return [...pids].sort((a, b) => a - b);
}

/**
 * The Claude Desktop process owning this session, or a reason there is not exactly one.
 *
 * Deliberately refuses rather than picks when several instances hold the session. A lowest-pid
 * tiebreak is stable but silent: it resolves to whichever instance launched first, which is
 * unrelated to the window the user is looking at, and a write to the wrong instance is
 * indistinguishable from a correct one until the text lands in another Desktop's session.
 */
export function sessionOwner(resolution: SessionResolution): number | { reason: WindowInputReason } {
  const pids = claudeMainPids(resolution);
  if (pids.length === 1) return pids[0]!;
  if (pids.length > 1) return { reason: "multiple-instances" };
  return { reason: resolution.chains.length === 0 ? "not-running" : "terminal-only" };
}

/**
 * One decoded row of Claude Code's per-pid session registry, `~/.claude/sessions/<pid>.json`.
 *
 * The child CLI writes one file per running session, keyed by the CLI's real pid, at session spawn
 * and before any message is sent. `sessionId` is the SAME id that names the feed session, and
 * `entrypoint` names the launching surface. Fields resolution does not need are ignored.
 */
export interface SessionRegistryEntry {
  pid: number;
  sessionId: string;
  entrypoint?: string;
}

/** Every readable registry row. A malformed file is skipped so one bad row cannot poison the rest. */
export function registryEntries(directory: string): SessionRegistryEntry[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: SessionRegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const decoded = JSON.parse(readFileSync(join(directory, name), "utf8")) as SessionRegistryEntry;
      if (typeof decoded.pid === "number" && typeof decoded.sessionId === "string") entries.push(decoded);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * The Claude Desktop window owning a NEW session.
 *
 * A brand-new session -- created inside Claude Desktop, not resumed -- never puts its id in a child
 * argv, so the argv resolver returns "not-running" for a window that is plainly open. The registry
 * row supplies the pid, and the parent chain still decides whether it is a Desktop session. A row is
 * live only while its pid's chain reaches Claude.app, so a stale row left behind by a closed session
 * never resolves to a window.
 */
export function desktopOwner(
  sessionId: string,
  rows: ProcessRow[],
  claudeMainPath: string = config.claudeDesktopMainPath,
  // The same `~/.claude/sessions` the catalog already reads for inbox and background-task
  // authority. One directory, one config key: a second entry pointing at the same place is how the
  // two drift when an install moves.
  directory: string = config.claudeSessionsDirectory,
  entrypoint: string = config.claudeDesktopRegistryEntrypoint,
): number | null {
  const owners: number[] = [];
  for (const entry of registryEntries(directory)) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.entrypoint !== entrypoint) continue;
    const link = chain(entry.pid, rows, claudeMainPath);
    if (link.kind !== "desktop") continue;
    if (!owners.includes(link.claudeMainPid)) owners.push(link.claudeMainPid);
  }
  return owners.length === 1 ? owners[0]! : null;
}

/**
 * Turns a resolved Claude pid into the window and Desktop the composer needs.
 *
 * Windows come from the helper's `desktop-audit` rather than a window list of this feature's own:
 * the audit already lists off-Space windows with their Space membership, and a second window source
 * is exactly the divergence ADR-0092 consolidated away.
 */
export function target(sessionId: string, claudeMainPid: number, snapshot: DesktopAuditSnapshot): WindowResolution {
  if (snapshot.activeSpaceID === null || snapshot.diagnostic !== null) {
    return { ok: false, reason: "placement-unavailable" };
  }
  // Titles are the filter below, and a reader without Screen Recording sees every one of them as
  // empty. Refusing here is the difference between "this Mac has no titled Claude window" and "this
  // process cannot see titles", which are otherwise the same answer.
  if (!snapshot.screenRecordingTrusted) return { ok: false, reason: "placement-unavailable" };

  const activeSpaceID = snapshot.activeSpaceID;
  // Ordinary app windows only. Layer 0 excludes panels, sheets, and the status-item and shadow
  // entries the window list also reports for the same process, none of which hold the composer.
  //
  // Layer 0 alone is NOT enough, which cost a long diagnosis: one Claude Desktop instance was
  // measured owning eight layer-0 windows -- four 1800x39 strips, two 800x600, one 500x500, and the
  // real 644x795 browser window. Only the last carries a title; Electron's scaffolding windows are
  // all untitled. Without this filter the lowest-windowID scaffolding window on the active Space
  // wins the selection below, the target then reads as already-on-the-active-Desktop, so no move
  // happens, and the REAL window keeps the collapsed accessibility tree Chromium gives a window on
  // another Space. That surfaces as "composer missing" with nothing pointing at the window it
  // actually looked in.
  const candidates = snapshot.windows
    .filter((window) => window.ownerPID === claudeMainPid && window.layer === 0)
    .filter((window) => window.title.length > 0)
    .filter((window) => window.spaceIDs.length === 1)
    .sort((a, b) => a.windowID - b.windowID);

  const window = candidates.find((candidate) => candidate.spaceIDs[0] === activeSpaceID) ?? candidates[0];
  const homeSpaceID = window?.spaceIDs[0];
  if (!window || homeSpaceID === undefined) return { ok: false, reason: "no-window" };

  const resolved: WindowTarget = {
    sessionId,
    claudeMainPid,
    windowID: window.windowID,
    homeSpaceID,
    activeSpaceID,
    bounds: window.bounds,
    onActiveDesktop: homeSpaceID === activeSpaceID,
  };
  return { ok: true, target: resolved };
}

/**
 * Reads the live process table.
 *
 * `-ww` is load-bearing: without it `ps` truncates argv at the terminal width, and the
 * `--resume=<sessionId>` marker sits at the end of a long Claude Code command line, so a truncated
 * row silently reads as "session not running".
 */
export async function liveProcessRows(): Promise<ProcessRow[]> {
  const child = Bun.spawn(["/bin/ps", "-axww", "-o", "pid=,ppid=,args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(child.stdout as ReadableStream).text();
  const status = await child.exited;
  if (status !== 0) return [];
  return parseProcessTable(text);
}
