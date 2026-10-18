// What the kernel says every process is doing: one `ps` snapshot, parsed, walked, and
// shared for the length of a tick.
//
// Kept apart from the descriptor probe because the two answer different questions of
// different commands: this one names what is running, `processProbe.ts` names which task
// it belongs to and where its output goes.

import { config } from "@/config/config";
import { parseProcessLstart } from "@/tasks/processStartTime";
import { PS_BINARY, runCommand, type CommandRunner } from "@/tasks/commandRunner";

/** One row of the process table: enough to rebuild the tree and say what each node is doing. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Process start, epoch ms local, from `ps -o lstart=`. */
  startedAt: number;
  /** CPU consumed, ms, from `ps -o time=`. */
  cpuMs: number;
  /**
   * The full argv, still wrapped if this is a task shell, with `ps`'s octal escapes already
   * decoded back into the control characters they stand for.
   */
  command: string;
}

/** What a live shell is running, and since when, asked of the kernel rather than the transcript. */
export interface ShellDetail {
  pid: number;
  startedAt: number;
  /** The agent's command, unwrapped from the harness's shell preamble. */
  command: string;
}

/**
 * Recover the agent's own command from a task shell's full argv.
 *
 * The harness does not hand the shell a bare command. It prepends a snapshot `source`, a `setopt`,
 * and some alias cleanup, and appends a `pwd -P` that tracks the working directory -- then wraps
 * the part the agent actually wrote in `eval '…' < /dev/null`. Measured on a live shell:
 *
 *   /bin/zsh -c source …/snapshot-zsh-….sh 2>/dev/null || true && setopt … || true
 *     && { \builtin unalias -- 'unsetenv'; … } >/dev/null 2>&1 || true
 *     && eval 'sleep 30 > /dev/null 2>&1' < /dev/null && pwd -P >| /tmp/claude-9b7a-cwd
 *
 * That wrapper is a fifth undocumented harness artifact, so a miss returns the whole argv rather
 * than nothing: an unwrapped command line is ugly but still tells the viewer what is running, where
 * an empty string would read as a task with no identity at all.
 *
 * The match is greedy to the LAST `' < /dev/null`, because the agent's own command may contain the
 * same text and the outer wrapper is the one that closes last.
 */
export function unwrapShellCommand(argv: string): string {
  const match = /\beval '(.*)' < \/dev\/null\b/s.exec(argv);
  if (!match?.[1]) return argv.trim();
  // An interior single quote cannot appear inside a single-quoted string, so it is spliced. The
  // harness emits the `'"'"'` form -- close, double-quoted quote, reopen -- measured on a live
  // watcher whose python filter contains `line.startswith('{')`. Missing it left the unwrapped
  // command 88 characters longer than the one the transcript recorded, so every comparison against
  // it failed and the watcher could not be found. `'\''` is the other standard spelling of the
  // same trick and costs one line to accept.
  return match[1].replaceAll(`'"'"'`, "'").replaceAll(`'\\''`, "'").trim();
}

/**
 * `ps -o time=`, in ms.
 *
 * macOS prints `MM:SS.hh` with the minutes UNBOUNDED -- a long-lived daemon reads `4318:19.61`,
 * not `71:58:19`. So the last field is seconds and everything before it is minutes, with an hours
 * field tolerated in case a future format grows one.
 */
export function parseCpuTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let ms = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const value = Number(parts[index]);
    if (!Number.isFinite(value) || value < 0) return null;
    // Seconds last, minutes before it, hours before that.
    const unit = [3_600_000, 60_000, 1000][index + (3 - parts.length)]!;
    ms += value * unit;
  }
  return ms;
}

/**
 * Parse `ps -eo pid=,ppid=,lstart=,time=,command=`.
 *
 * Positional, and it has to be: the command field contains arbitrary spaces, so only the fixed
 * shape of the leading fields -- pid, ppid, ctime's five, cpu time -- makes the split unambiguous.
 */
export function parseProcessTable(text: string): ProcessRow[] {
  const out: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 9) continue;
    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    const startedAt = parseProcessLstart(tokens.slice(2, 7).join(" "));
    const cpuMs = parseCpuTime(tokens[7]!);
    if (startedAt === null || cpuMs === null) continue;
    // Rejoin from the ORIGINAL line rather than from the split tokens, so runs of spaces inside
    // the command survive. `ps` right-pads its columns, so the command does not start at a fixed
    // offset -- it starts at the first token after the cpu time.
    const afterCpu = line.indexOf(tokens[7]!) + tokens[7]!.length;
    const commandStart = line.indexOf(tokens[8]!, afterCpu);
    out.push({
      pid,
      ppid,
      startedAt,
      cpuMs,
      // Decoded HERE, per row, and not before the line split: an argv's newlines are what `ps`
      // spelled `\012` in the first place, so restoring them any earlier would tear one process's
      // row into several unparseable ones.
      command: decodeArgvEscapes(
        commandStart === -1 ? tokens.slice(8).join(" ") : line.slice(commandStart),
      ),
    });
  }
  return out;
}

/**
 * Every process on the machine, in one fork.
 *
 * One table rather than a `pgrep` per tree node: the probe needs both the task shells' own argv
 * and their whole descendant trees, and walking with `pgrep -P` costs a fork per node while this
 * costs one no matter how many tasks are in flight. Measured: 242 KB and 40 ms, against a poll
 * that only runs while a panel is open.
 *
 * Not filtered to this user, deliberately. A task that starts something under another uid still
 * belongs to that task, and the parent chain is what proves it.
 */
export async function processTable(run: CommandRunner): Promise<ProcessRow[]> {
  const text = await run([PS_BINARY, "-eo", "pid=,ppid=,lstart=,time=,command="]);
  const rows = parseProcessTable(text);
  // The canary for a `ps` output format we no longer understand. Every consumer of this table
  // reads an unparseable row as an absent process, which is indistinguishable from "nothing is
  // running" -- the same silent shape the `LC_ALL=C` scar above already cost once. A machine
  // with processes on it never parses to zero rows, so that combination is said out loud.
  if (rows.length === 0 && text.trim() !== "") {
    console.error(JSON.stringify({
      event: "agent-feed-process-table-unparsed",
      sample: text.slice(0, 200),
    }));
  }
  return rows;
}

/**
 * The same table, shared by everything that asks within one tick.
 *
 * Every caller below used to reach the kernel its own way -- `liveSessionProcesses` forking
 * `ps -p <pid>` once per registry record, `taskShellsOf` forking `pgrep -P` -- and all of it was
 * already contained in the one table above. Measured on this machine: 19 registry records cost 19
 * forks and 45-53 ms per pass, PER TICK, PER subscribed session, against one fork and 30-50 ms for
 * the whole table. The per-record loop is also the term that made a wall of open sessions
 * quadratic, since each session's tick re-walked every session's record.
 *
 * The window is half the fastest poll that consumes it, so a tick never reads a table the previous
 * tick fetched, and the several probes inside ONE tick share a single fork. Derived from
 * `backgroundTaskPollMs` rather than configured beside it: two knobs that must stay ordered
 * relative to each other is a way to misconfigure staleness, not a way to tune it.
 *
 * In-flight requests are shared too. Subscribers tick together, so without this the first
 * simultaneous pass would fork once per subscriber before any of them resolved -- which is the
 * cost this exists to remove.
 */
const PROCESS_TABLE_WINDOW_MS = Math.floor(config.backgroundTaskPollMs / 2);

let tableCache: { at: number; rows: readonly ProcessRow[] } | null = null;
let tableInFlight: Promise<readonly ProcessRow[]> | null = null;

export async function currentProcessTable(
  run: CommandRunner = runCommand,
  now: () => number = Date.now,
): Promise<readonly ProcessRow[]> {
  const at = now();
  if (tableCache && at - tableCache.at < PROCESS_TABLE_WINDOW_MS) return tableCache.rows;
  if (tableInFlight) return tableInFlight;
  tableInFlight = processTable(run)
    .then((rows) => {
      tableCache = { at: now(), rows };
      return rows;
    })
    .finally(() => {
      tableInFlight = null;
    });
  return tableInFlight;
}

/** Drops the shared table, so one test's kernel is never another's. */
export function resetProcessTableCache(): void {
  tableCache = null;
  tableInFlight = null;
}

/** Index a table by parent, so a tree walk is not quadratic in the process count. */
function childrenByParent(rows: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const index = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const bucket = index.get(row.ppid);
    if (bucket) bucket.push(row);
    else index.set(row.ppid, [row]);
  }
  return index;
}

/** Every process under `pid`, excluding `pid` itself. */
export function descendantsOf(rows: readonly ProcessRow[], pid: number): ProcessRow[] {
  const index = childrenByParent(rows);
  const seen = new Set<number>([pid]);
  const found: ProcessRow[] = [];
  const frontier = [pid];
  while (frontier.length > 0) {
    for (const child of index.get(frontier.pop()!) ?? []) {
      // A cycle cannot happen in a real process table, but a pid reused between the ps snapshot
      // and this walk could fake one, and an unbounded loop inside a 2s poll is not recoverable.
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      frontier.push(child.pid);
    }
  }
  return found;
}

/**
 * The descendant worth naming: the one that has used the most CPU.
 *
 * CPU rather than depth or recency, because it picks the step doing the work out of the plumbing
 * around it without needing to know which is which. In `node build.ts | tail -16` the wrapper
 * shells and `tail` sit at nearly zero while `node` climbs, so `node` is named. When a script
 * moves to its next step the previous process is gone from the table, so the answer follows along
 * by itself.
 *
 * Ties break toward the most recently started, which is the right answer for a tree that has not
 * burned any CPU at all -- a pipeline of `sleep`s reports the newest `sleep`, not an arbitrary one.
 */
export function busiestDescendant(rows: readonly ProcessRow[], pid: number): ProcessRow | null {
  let best: ProcessRow | null = null;
  for (const row of descendantsOf(rows, pid)) {
    if (
      best === null ||
      row.cpuMs > best.cpuMs ||
      (row.cpuMs === best.cpuMs && row.startedAt > best.startedAt)
    ) {
      best = row;
    }
  }
  return best;
}

/** A task shell's own identity, from a table already fetched. */
export function shellDetailFrom(rows: readonly ProcessRow[], pid: number): ShellDetail | null {
  const row = rows.find((candidate) => candidate.pid === pid);
  if (!row) return null;
  return { pid, startedAt: row.startedAt, command: unwrapShellCommand(row.command) };
}

/**
 * Undo `ps`'s octal rendering of the control characters in an argv.
 *
 * `ps` prints a literal `\012` everywhere the agent wrote a newline, and a multi-line command is
 * routine here -- the measured Monitor embeds a whole `python3 -c` script. Left encoded it breaks
 * two things at once: the join against the command the transcript recorded never matches, so the
 * watcher cannot be found at all; and what does get shown is one unbroken line with `\012` sitting
 * where every newline and indent should be, which no amount of wrapping in the panel can repair.
 */
function decodeArgvEscapes(text: string): string {
  return text.replaceAll("\\012", "\n").replaceAll("\\011", "\t");
}

/**
 * Match live shells to commands the transcript recorded, by what they are running.
 *
 * This is the join for tasks with no capture file. A Monitor's shell holds only a socket pair, so
 * the descriptor trick that identifies every backgrounded shell has nothing to grip -- but the
 * harness runs the agent's command verbatim, so the command itself is the identity.
 *
 * Each shell is claimed at most once, and the closest start time wins, so two watchers on the same
 * command land on different shells instead of both on the first one. Ambiguity beyond that is
 * resolved by order rather than left to chance, and a command with no live shell simply gets no
 * answer: absence here means "not running", which is exactly the question being asked.
 */
export function matchShellsByCommand(
  rows: readonly ProcessRow[],
  parentPid: number,
  wanted: readonly { key: string; command: string; startedAt: number | null }[],
): Map<string, ProcessRow> {
  const candidates = rows.filter((row) => row.ppid === parentPid).map((row) => ({
    row,
    command: unwrapShellCommand(row.command),
  }));
  const claimed = new Set<number>();
  const matched = new Map<string, ProcessRow>();
  for (const entry of wanted) {
    const target = entry.command.trim();
    let best: ProcessRow | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (claimed.has(candidate.row.pid) || candidate.command !== target) continue;
      const distance = entry.startedAt === null
        ? 0
        : Math.abs(candidate.row.startedAt - entry.startedAt);
      if (best === null || distance < bestDistance) {
        best = candidate.row;
        bestDistance = distance;
      }
    }
    if (best === null) continue;
    claimed.add(best.pid);
    matched.set(entry.key, best);
  }
  return matched;
}
