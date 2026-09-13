// Asking the kernel which background tasks a session is actually running, and where their output
// is really going.
//
// The join that makes this exact rather than heuristic: a background task's shell holds its own
// `…/tasks/<task-id>.output` open for WRITING. So the descriptor names the task. No matching of
// command strings, no guessing from timestamps, no chance of attributing one task's output to
// another.
//
// It is the descriptor's NAME that identifies the task, never its number. The number was once
// assumed to be 1, and that assumption cost a whole class of task: when the agent's own command
// redirects or pipes its top-level stdout -- `{ … } > results/bakeoff.log 2>&1`, the shape a
// well-behaved agent writes for anything long -- zsh puts the redirect on fd 1 and moves the
// harness's capture to a saved descriptor in the teens. Measured on a live run: fd 1 and 2 were the
// log, fds 12 and 14 were the capture. Those tasks were reported as not running, which the panel
// then rendered as finished-with-unknown-outcome, forever.
//
// The second trick is why the feature exists at all. A well-behaved agent redirects a long
// command into a log file and reads only the tail at the end, which leaves that stdout capture
// empty -- the shape other tools render as "No output yet". Walking the shell's DESCENDANTS and
// reading their fd 1 finds the file the work is really being written to.

import { config } from "../config.ts";
import { parseProcessLstart } from "./processStartTime.ts";

/** Injected so tests never fork. Returns stdout; a failed command yields an empty string. */
export type CommandRunner = (argv: readonly string[]) => Promise<string>;

/**
 * Absolute, because this process is not started from a shell.
 *
 * The sidecar is spawned by the Mac host, and PATH resolution there is not the PATH resolution a
 * developer sees in their terminal. Resolving by name works right up until it does not, and the
 * failure is invisible: an empty answer from `lsof` reads exactly like "this session is running
 * nothing". The repo already carries this scar for `/usr/bin/log`, which has to be invoked
 * absolutely for the same class of reason.
 */
export const PS_BINARY = "/bin/ps";
const LSOF_BINARY = "/usr/sbin/lsof";

export const runCommand: CommandRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv as string[], {
      stdout: "pipe",
      stderr: "pipe",
      // The C locale, because we PARSE this output.
      //
      // `ps -o lstart=` is locale-formatted. Under the Mac host's inherited `LANG=en_CA.UTF-8`
      // it prints `Fri 14 Aug 13:10:48 2026` -- day before month -- where a C-locale shell prints
      // `Fri Aug 14 13:10:48 2026`. Every session was then rejected as a pid-reuse mismatch, and
      // the panel reported no background work at all, on a machine that had plenty.
      env: { ...process.env, LC_ALL: "C" },
    });
    const [text, diagnostic] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    // A non-zero exit is an ordinary answer here: `lsof` exits non-zero when a pid has already
    // gone. Producing NOTHING while complaining on stderr is not -- that is the tool declining to
    // run, and it used to be indistinguishable from a quiet machine.
    if (code !== 0 && !text && diagnostic.trim()) {
      console.error(JSON.stringify({
        event: "agent-feed-task-probe-failed",
        command: argv[0],
        exitCode: code,
        detail: diagnostic.trim().slice(0, 200),
      }));
    }
    return text;
  } catch (error) {
    // Could not be started at all -- missing binary, denied exec. Loud, because the alternative
    // is a panel that quietly reports no background work forever.
    console.error(JSON.stringify({
      event: "agent-feed-task-probe-unavailable",
      command: argv[0],
      detail: String(error).slice(0, 200),
    }));
    return "";
  }
};

export interface TaskShell {
  taskId: string;
  /** The shell the harness started for this task. Its lifetime is the task's lifetime. */
  pid: number;
  /** The harness's stdout capture. Often empty -- see the note at the top of this file. */
  capturePath: string;
}

interface LsofDescriptor {
  pid: number;
  fd: string;
  /** lsof's access mode: `r`, `w`, `u` (read-write), or a space for entries that have none. */
  access: string;
  name: string;
}

/**
 * Parse `lsof -F pfan` output.
 *
 * The field format emits one item per line, prefixed by a type character, and it is stateful: a
 * `p` line opens a process and every `f`/`a`/`n` group after it belongs to that process until the
 * next `p`. Parsing it positionally is what keeps this readable; the human-facing table format
 * would need column alignment guesses.
 *
 * The access mode is tracked because it is the only thing separating the shell WRITING a task's
 * capture from some other process merely reading it.
 */
export function parseLsofDescriptors(text: string): LsofDescriptor[] {
  const out: LsofDescriptor[] = [];
  let pid: number | null = null;
  let fd: string | null = null;
  let access = "";
  for (const line of text.split("\n")) {
    if (!line) continue;
    const kind = line[0];
    const value = line.slice(1);
    if (kind === "p") {
      const parsed = Number(value);
      pid = Number.isSafeInteger(parsed) ? parsed : null;
      fd = null;
      access = "";
    } else if (kind === "f") {
      fd = value;
      // Each descriptor carries its own mode; a missing `a` field must not inherit the last one.
      access = "";
    } else if (kind === "a") {
      access = value.trim();
    } else if (kind === "n" && pid !== null && fd !== null) {
      out.push({ pid, fd, access, name: value });
    }
  }
  return out;
}

const CAPTURE_PATH = /\/tasks\/([A-Za-z0-9]+)\.output$/;

/**
 * Task ids recovered from a set of descriptors.
 *
 * Any descriptor number is accepted, because the number is not stable -- see the note at the top of
 * this file. The task id comes from the path, and the map is keyed by it, so the several
 * descriptors one shell holds on the same capture collapse to one shell rather than to one task
 * counted several times.
 *
 * Write access is required. It is what says this process OWNS the capture: a shell the harness
 * started to run the task holds it `w`, where anything that merely reads a finished task's output
 * -- the agent's own `cat`, for one -- holds it `r`, and counting that would resurrect a task that
 * ended hours ago as running.
 */
export function taskShellsFromDescriptors(descriptors: readonly LsofDescriptor[]): TaskShell[] {
  const shells = new Map<string, TaskShell>();
  for (const descriptor of descriptors) {
    if (descriptor.access !== "w" && descriptor.access !== "u") continue;
    const match = CAPTURE_PATH.exec(descriptor.name);
    if (!match) continue;
    if (!isInsideTaskRoot(descriptor.name)) continue;
    shells.set(match[1]!, { taskId: match[1]!, pid: descriptor.pid, capturePath: descriptor.name });
  }
  return [...shells.values()];
}

/**
 * Whether a path is where the harness parks task output.
 *
 * A fence, not a path builder. Everything we open is discovered -- from the kernel for a running
 * task, from the harness's own tool_result text for a finished one -- and this is the check that
 * a discovered path is somewhere we are willing to read before we read it.
 */
export function isInsideTaskRoot(path: string): boolean {
  const root = config.claudeTaskRoot.endsWith("/") ? config.claudeTaskRoot : `${config.claudeTaskRoot}/`;
  return path.startsWith(root) && !path.includes("/..");
}

/**
 * The background tasks each of several sessions is running right now, keyed by owner pid.
 *
 * MANY owners in one call, because the fork is the expensive part and `lsof` takes a pid list. A
 * wall of open sessions used to spend one `lsof` per session per tick -- the single most expensive
 * probe here at 60-80 ms -- where the answers all came out of the same kernel at the same moment.
 * Sessions absent from the result simply have no task shells; the caller reads a missing key as an
 * empty list rather than as a failure.
 *
 * The children come from the shared table rather than from a `pgrep -P` of their own: `ppid` is
 * already in every row, so the fork bought a column the caller was holding anyway. That same column
 * is what attributes each shell back to its session afterwards, so widening the call does not blur
 * whose task is whose.
 */
export async function taskShellsByOwner(
  run: CommandRunner,
  ownerPids: readonly number[],
  table: readonly ProcessRow[],
): Promise<Map<number, TaskShell[]>> {
  const owners = new Set(ownerPids);
  const ownerByChild = new Map<number, number>();
  for (const row of table) {
    if (owners.has(row.ppid)) ownerByChild.set(row.pid, row.ppid);
  }
  const shellsByOwner = new Map<number, TaskShell[]>();
  if (ownerByChild.size === 0) return shellsByOwner;
  // Every descriptor, not a range. `-d 0-3` was the original filter and it is exactly what hid a
  // redirected task, whose capture sat on fd 12. Any range is a guess at where zsh parks a saved
  // descriptor, and guessing wrong fails silently as "nothing is running"; the name filter in
  // `taskShellsFromDescriptors` is the real discriminator. Measured on a live session with four
  // children including three MCP servers: 244 lines, 19 ms.
  const text = await run([LSOF_BINARY, "-p", [...ownerByChild.keys()].join(","), "-F", "pfan"]);
  for (const shell of taskShellsFromDescriptors(parseLsofDescriptors(text))) {
    const owner = ownerByChild.get(shell.pid);
    // A descriptor for a pid nobody asked about. `lsof` was given an explicit list so this should
    // not happen, but attributing it to an arbitrary session would report one session's task as
    // another's, which is worse than dropping it.
    if (owner === undefined) continue;
    const bucket = shellsByOwner.get(owner);
    if (bucket) bucket.push(shell);
    else shellsByOwner.set(owner, [shell]);
  }
  return shellsByOwner;
}

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
      return rows as readonly ProcessRow[];
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

/**
 * Where a task's output is really going, which is not always its stdout capture.
 *
 * Walks the task shell's descendants and collects the regular files they hold on fd 1. Deduped by
 * path, because a subshell and its child both hold the same descriptor and reporting it twice
 * would render the log twice.
 */
export async function outputTargetsOf(run: CommandRunner, shell: TaskShell): Promise<string[]> {
  // One table and a pure walk, rather than a `pgrep -P` per node. There is exactly one tree walk
  // in this module and this is it -- a second one written against `pgrep` would drift from this
  // one the first time either grew a rule, and they answer the same question.
  const seen = descendantsOf(await currentProcessTable(run), shell.pid).map((row) => row.pid);
  if (seen.length === 0) return [];
  // `-F pfan`, not `pn`: the parser is stateful and pairs each name with the descriptor that
  // preceded it, so omitting the `f` field yields a stream it cannot attribute and drops silently.
  //
  // fd 1 IS the right filter here, unlike in `taskShellsOf`. This asks a descendant where its
  // stdout goes, which is the question; the shell's own saved descriptors are not.
  const text = await run([LSOF_BINARY, "-p", [...seen].join(","), "-a", "-d", "1", "-F", "pfan"]);
  const targets: string[] = [];
  for (const descriptor of parseLsofDescriptors(text)) {
    if (descriptor.fd !== "1") continue;
    if (!descriptor.name.startsWith("/")) continue;
    if (descriptor.name === shell.capturePath) continue;
    if (targets.includes(descriptor.name)) continue;
    targets.push(descriptor.name);
  }
  return targets;
}
