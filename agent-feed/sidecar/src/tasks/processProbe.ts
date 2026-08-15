// Asking the kernel which background tasks a session is actually running, and where their output
// is really going.
//
// The join that makes this exact rather than heuristic: a background task's shell holds its own
// `…/tasks/<task-id>.output` open on fd 1. So the descriptor names the task. No matching of
// command strings, no guessing from timestamps, no chance of attributing one task's output to
// another.
//
// The second trick is why the feature exists at all. A well-behaved agent redirects a long
// command into a log file and reads only the tail at the end, which leaves that stdout capture
// empty -- the shape other tools render as "No output yet". Walking the shell's DESCENDANTS and
// reading their fd 1 finds the file the work is really being written to.

import { config } from "../config.ts";

/** Injected so tests never fork. Returns stdout; a failed command yields an empty string. */
export type CommandRunner = (argv: readonly string[]) => Promise<string>;

/**
 * Absolute, because this process is not started from a shell.
 *
 * The sidecar is spawned by the Mac host, and PATH resolution there is not the PATH resolution a
 * developer sees in their terminal. Resolving by name works right up until it does not, and the
 * failure is invisible: an empty answer from `pgrep` reads exactly like "this session is running
 * nothing". The repo already carries this scar for `/usr/bin/log`, which has to be invoked
 * absolutely for the same class of reason.
 */
export const PS_BINARY = "/bin/ps";
const PGREP_BINARY = "/usr/bin/pgrep";
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
    // A non-zero exit is an ordinary answer here: `pgrep` exits 1 when nothing matches, `lsof`
    // when a pid has already gone. Producing NOTHING while complaining on stderr is not -- that
    // is the tool declining to run, and it used to be indistinguishable from a quiet machine.
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
  name: string;
}

/**
 * Parse `lsof -F pfn` output.
 *
 * The field format emits one item per line, prefixed by a type character, and it is stateful: a
 * `p` line opens a process and every `f`/`n` pair after it belongs to that process until the next
 * `p`. Parsing it positionally is what keeps this readable; the human-facing table format would
 * need column alignment guesses.
 */
export function parseLsofDescriptors(text: string): LsofDescriptor[] {
  const out: LsofDescriptor[] = [];
  let pid: number | null = null;
  let fd: string | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const kind = line[0];
    const value = line.slice(1);
    if (kind === "p") {
      const parsed = Number(value);
      pid = Number.isSafeInteger(parsed) ? parsed : null;
      fd = null;
    } else if (kind === "f") {
      fd = value;
    } else if (kind === "n" && pid !== null && fd !== null) {
      out.push({ pid, fd, name: value });
    }
  }
  return out;
}

const CAPTURE_PATH = /\/tasks\/([A-Za-z0-9]+)\.output$/;

/**
 * Task ids recovered from a set of descriptors.
 *
 * Only fd 1 counts. fd 2 points at the same file for these shells, and accepting it would report
 * each task twice; fd 0 is the null device the harness gives them.
 */
export function taskShellsFromDescriptors(descriptors: readonly LsofDescriptor[]): TaskShell[] {
  const shells = new Map<string, TaskShell>();
  for (const descriptor of descriptors) {
    if (descriptor.fd !== "1") continue;
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

async function childPids(run: CommandRunner, pid: number): Promise<number[]> {
  const text = await run([PGREP_BINARY, "-P", String(pid)]);
  return text.split(/\s+/).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
}

/** The background tasks a session's process is running right now. */
export async function taskShellsOf(run: CommandRunner, claudePid: number): Promise<TaskShell[]> {
  const children = await childPids(run, claudePid);
  if (children.length === 0) return [];
  // One lsof for every child rather than one per child: the fork is the expensive part, and the
  // session's MCP servers and language servers are in this list too.
  const text = await run([LSOF_BINARY, "-p", children.join(","), "-a", "-d", "0-3", "-F", "pfn"]);
  return taskShellsFromDescriptors(parseLsofDescriptors(text));
}

/**
 * Where a task's output is really going, which is not always its stdout capture.
 *
 * Walks the task shell's descendants and collects the regular files they hold on fd 1. Deduped by
 * path, because a subshell and its child both hold the same descriptor and reporting it twice
 * would render the log twice.
 */
export async function outputTargetsOf(run: CommandRunner, shell: TaskShell): Promise<string[]> {
  const seen = new Set<number>();
  const frontier = [shell.pid];
  while (frontier.length > 0) {
    const pid = frontier.pop()!;
    for (const child of await childPids(run, pid)) {
      if (seen.has(child)) continue;
      seen.add(child);
      frontier.push(child);
    }
  }
  if (seen.size === 0) return [];
  // `-F pfn`, not `pn`: the parser is stateful and pairs each name with the descriptor number that
  // preceded it, so omitting the `f` field yields a stream it cannot attribute and drops silently.
  const text = await run([LSOF_BINARY, "-p", [...seen].join(","), "-a", "-d", "1", "-F", "pfn"]);
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
