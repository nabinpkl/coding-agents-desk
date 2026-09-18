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
import { realpathSync } from "node:fs";
import { config } from "@/config";
import { LSOF_BINARY, type CommandRunner } from "@/tasks/commandRunner";
import {
  busiestDescendant,
  currentProcessTable,
  descendantsOf,
  type ProcessRow,
} from "@/tasks/processTable";

// Re-exported because this is the address every caller of the task probe already has, and
// the two halves are one reading of one machine. The declarations live in the modules named.
export { runCommand, PS_BINARY, type CommandRunner } from "@/tasks/commandRunner";
export {
  busiestDescendant,
  currentProcessTable,
  descendantsOf,
  matchShellsByCommand,
  parseCpuTime,
  parseProcessTable,
  processTable,
  resetProcessTableCache,
  shellDetailFrom,
  unwrapShellCommand,
  type ProcessRow,
  type ShellDetail,
} from "@/tasks/processTable";

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

/** Cached per root, because where a directory really is cannot move under a running process. */
const spellingsByRoot = new Map<string, readonly string[]>();

function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * Every name this machine reaches the task root by: the configured one, and where it really is.
 *
 * Two names for one directory is the ordinary case rather than an exotic one. On a Mac `/tmp` is a
 * symlink to `/private/tmp`, and the harness writes whichever spelling it happened to resolve --
 * measured here, 23,540 capture paths under `/private/tmp` and 354 under `/tmp`, for the same
 * files. A fence that knows one spelling silently refuses the other, and refusing reads as "that
 * task has no output" rather than as a mismatch.
 *
 * A root that does not resolve is not cached, so one created later is picked up without a restart.
 */
export function taskRootSpellings(root: string): readonly string[] {
  const cached = spellingsByRoot.get(root);
  if (cached) return cached;
  const literal = withSlash(root);
  let spellings: readonly string[] = [literal];
  try {
    const real = withSlash(realpathSync(root));
    if (real !== literal) spellings = [literal, real];
    spellingsByRoot.set(root, spellings);
  } catch {
    // Nothing there yet. Answer with the literal spelling and ask again next time.
  }
  return spellings;
}

/**
 * Whether a path is where the harness parks task output.
 *
 * A fence, not a path builder. Everything we open is discovered -- from the kernel for a running
 * task, from the harness's own tool_result text for a finished one -- and this is the check that
 * a discovered path is somewhere we are willing to read before we read it.
 *
 * Accepting both spellings of one directory widens nothing: they are the same inode, and the
 * traversal check below is what keeps a discovered path from climbing out of it.
 */
export function isInsideTaskRoot(path: string): boolean {
  if (path.includes("/..")) return false;
  return taskRootSpellings(config.claudeTaskRoot).some((root) => path.startsWith(root));
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
