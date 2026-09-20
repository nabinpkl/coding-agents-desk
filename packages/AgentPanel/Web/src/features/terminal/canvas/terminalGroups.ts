// Which tmux sessions stand under which directory on the terminal canvas.
//
// A parent is a project directory and its children are the tmux sessions working in it -- the
// same shape as a Bot, minus everything a Bot is besides that: no provider sessions, no
// curation, no transcripts. Grouping is automatic because there is nothing to curate: a session
// belongs to the directory tmux reports, full stop.
//
// Three sources make the parents, and all three are facts the stream owns rather than
// arrangements the reader made:
//
// - **Live tmux sessions**, by the `path` each one reports. A session working in a directory
//   puts that directory on the canvas whether anything registered it or not.
// - **Workspace roots** (`GET /api/workspace/list`). An empty parent is still a parent: it is
//   where the reader starts a shell when nothing is running there yet.
// - **Bot directories**. A Bot IS a directory with sessions in it, so its directory stands on
//   this canvas too -- as a plain parent, with no Bot semantics attached.
//
// One grouping per machine, keyed `machine:path`. tmux names are unique per server but meaningless
// across machines, so a session on a peer never shares a parent with one here even when the paths
// match. A session with no path stands in that machine's residue group rather than nowhere: an
// unplaceable session is still a running session, and dropping it would hide work behind a field
// being empty.
//
// Pure: the shell feeds it snapshots and renders what comes back. Paths compare as raw strings --
// a trailing slash is stripped, but symlinks are not resolved, because the panel cannot
// canonicalise a peer's filesystem. Two spellings of one directory stand as two parents, which
// is honest about what the panel knows rather than a merge it cannot verify.

import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";

/** One machine's contribution to the canvas, as the shell already holds it. */
export interface TerminalGroupSource {
  /** The dev server's session id, `undefined` for the panel's own sidecar. */
  machineId?: string;
  machineLabel: string;
  sessions: readonly TmuxSessionSummary[];
  workspaceRoots: readonly string[];
  botDirs: readonly string[];
}

/** One directory's card: the directory and the sessions standing in it, name-sorted. */
export interface TerminalParentGroup {
  /** `machine:path`, the key stored preferences address. Empty path for a residue group. */
  key: string;
  machineId?: string;
  machineLabel: string;
  path: string;
  children: TmuxSessionSummary[];
}

export interface TerminalGrouping {
  /** Parents with a path, path-sorted. What the strip draws. */
  parents: TerminalParentGroup[];
  /** One per machine holding pathless sessions, in machine order. Drawn after the parents. */
  residue: TerminalParentGroup[];
}

function machineKey(machineId?: string): string {
  return machineId ?? "";
}

function parentKey(machineId: string | undefined, path: string): string {
  return `${machineKey(machineId)}:${path}`;
}

function cleanPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function groupTerminalsByDirectory(
  sources: readonly TerminalGroupSource[],
): TerminalGrouping {
  const parents: TerminalParentGroup[] = [];
  const residue: TerminalParentGroup[] = [];
  for (const source of sources) {
    const byPath = new Map<string, TmuxSessionSummary[]>();
    const homeless: TmuxSessionSummary[] = [];
    for (const session of source.sessions) {
      const path = cleanPath(session.path);
      if (!path) {
        homeless.push(session);
        continue;
      }
      const list = byPath.get(path);
      if (list) list.push(session);
      else byPath.set(path, [session]);
    }
    // Empty parents first, so a registered directory with nothing running in it still stands on
    // the canvas as the place a shell gets started.
    for (const dir of [...source.workspaceRoots, ...source.botDirs]) {
      const path = cleanPath(dir);
      if (!path || byPath.has(path)) continue;
      byPath.set(path, []);
    }
    const machineParents = [...byPath.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([path, children]) => ({
        key: parentKey(source.machineId, path),
        machineId: source.machineId,
        machineLabel: source.machineLabel,
        path,
        children: [...children].sort((a, b) => compareStrings(a.name, b.name)),
      }));
    parents.push(...machineParents);
    if (homeless.length > 0) {
      residue.push({
        key: parentKey(source.machineId, ""),
        machineId: source.machineId,
        machineLabel: source.machineLabel,
        path: "",
        children: [...homeless].sort((a, b) => compareStrings(a.name, b.name)),
      });
    }
  }
  return { parents, residue };
}

/** The child key stored preferences address: machine-scoped, because names are per-server. */
export function terminalChildKey(machineId: string | undefined, session: string): string {
  return `${machineKey(machineId)}:${session}`;
}

/**
 * What tmux accepts as `-t <session>`, the same door the sidecar guards.
 *
 * Kept beside the suggester rather than only on the sidecar so the naming form can refuse a
 * name before it travels: a rejection that arrives after the round trip still lands, as the
 * shell's add error, but the form should not send what it can already see is wrong.
 */
const TMUX_SESSION_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function isTerminalSessionNameValid(name: string): boolean {
  return TMUX_SESSION_PATTERN.test(name);
}

/**
 * The default name a shell this panel starts is offered under: `<dir>-<n>`.
 *
 * `<dir>` is the directory's leaf, folded to tmux identifier characters, and `<n>` starts at
 * the standing session count plus one and walks up past every collision -- so the first shell
 * in `agent-desk` beside two running sessions is offered as `agent-desk-3`, and a name taken
 * since the listing arrived is stepped over rather than joined. Names are per-server, so the
 * existing set must be the whole machine's listing, not just this directory's: offering a
 * name that stands elsewhere would join that session instead of starting one here.
 */
export function suggestTerminalSessionName(
  directoryPath: string,
  existingNames: Iterable<string>,
): string {
  const leaf = directoryPath.split("/").filter(Boolean).at(-1) ?? "";
  let slug = leaf
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9_]+/, "")
    .replace(/[-.]+$/, "");
  if (!slug) slug = "term";
  slug = slug.slice(0, 48);
  const taken = new Set(existingNames);
  let n = taken.size + 1;
  if (n < 1) n = 1;
  let candidate = `${slug}-${n}`;
  while (taken.has(candidate) && n < 100000) {
    n += 1;
    candidate = `${slug}-${n}`;
  }
  return candidate.slice(0, 64);
}

/**
 * Why a hand-typed session name cannot be started, or null when it can.
 *
 * The collision check reads the same machine-wide listing the suggestion does, for the same
 * reason: a name standing anywhere on that server is a join, not a start.
 */
export function terminalSessionNameError(
  name: string,
  existingNames: Iterable<string>,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the shell a name, or use the default.";
  if (!isTerminalSessionNameValid(trimmed)) {
    return "Letters, digits, _ , - and . only, starting with a letter, digit or _ .";
  }
  if (new Set(existingNames).has(trimmed)) return `${trimmed} is already standing -- pick another.`;
  return null;
}

/**
 * A fresh tmux session name for a shell this panel starts.
 *
 * Minted rather than asked for, because the name is an address the listing reports back: a
 * collision with a running session is a join at both the sidecar's existence check and tmux's
 * own `-A`, so two starters racing each other land on one shell rather than on an error. Eight
 * hex digits, which a typo cannot produce by accident and a reader cannot mistake for a name a
 * person gave.
 */
export function mintTerminalSessionName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `agentterm-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The machine and session a child key names, or null for a hand-edited one.
 *
 * Split on the FIRST colon, because that is where `terminalChildKey` puts it: machine keys
 * never hold one, and the sidecar refuses a session name that does.
 */
export function parseTerminalChildKey(key: string): { machineId: string | undefined; session: string } | null {
  const at = key.indexOf(":");
  if (at < 0 || at + 1 >= key.length || key.indexOf(":", at + 1) !== -1) return null;
  const machine = key.slice(0, at);
  return { machineId: machine === "" ? undefined : machine, session: key.slice(at + 1) };
}
