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
  //
  // Every descriptor, not a range. `-d 0-3` was the original filter and it is exactly what hid a
  // redirected task, whose capture sat on fd 12. Any range is a guess at where zsh parks a saved
  // descriptor, and guessing wrong fails silently as "nothing is running"; the name filter in
  // `taskShellsFromDescriptors` is the real discriminator. Measured on a live session with four
  // children including three MCP servers: 244 lines, 19 ms.
  const text = await run([LSOF_BINARY, "-p", children.join(","), "-F", "pfan"]);
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
