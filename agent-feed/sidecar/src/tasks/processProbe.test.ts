// What a session's open file descriptors say about the shells it has running.
//
// Nothing here forks: every reading is a canned `lsof` answer through `fakeRunner`.

import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import {
  type CommandRunner,
  outputTargetsOf,
  parseLsofDescriptors,
  type ProcessRow,
  resetProcessTableCache,
  taskShellsByOwner,
  taskShellsFromDescriptors,
} from "./processProbe.ts";

beforeEach(resetProcessTableCache);

const ROOT = config.claudeTaskRoot;
const SESSION = "895eadd3-2049-4e2f-9989-d30d0a90eb46";
const CAPTURE = `${ROOT}/-private-tmp/${SESSION}/tasks/bukxtjy7e.output`;
const OTHER_SESSION = "0b1d4f6c-8a2e-4c19-9f77-2b6d3e5a1c04";
const OTHER_CAPTURE = `${ROOT}/-private-tmp/${OTHER_SESSION}/tasks/bother999.output`;
const REAL_LOG = `${ROOT}/-private-tmp/${SESSION}/scratchpad/stream_test3.log`;

/** Answers canned stdout per command, so no test forks anything. */
function fakeRunner(table: Record<string, string>): CommandRunner {
  return async (argv) => table[argv.join(" ")] ?? "";
}

describe("parseLsofDescriptors", () => {
  test("pairs each name with the descriptor that preceded it", () => {
    // Real shape from `lsof -F pfan`: stateful, one field per line.
    const text = `p63854\nf1\naw\nn${CAPTURE}\nf2\naw\nn${CAPTURE}\np63891\nf1\naw\nn${REAL_LOG}\n`;
    expect(parseLsofDescriptors(text)).toEqual([
      { pid: 63854, fd: "1", access: "w", name: CAPTURE },
      { pid: 63854, fd: "2", access: "w", name: CAPTURE },
      { pid: 63891, fd: "1", access: "w", name: REAL_LOG },
    ]);
  });

  test("a name arriving before any descriptor is dropped rather than misattributed", () => {
    expect(parseLsofDescriptors(`n/tmp/orphan\np1\nf1\naw\nn/tmp/kept\n`)).toEqual([
      { pid: 1, fd: "1", access: "w", name: "/tmp/kept" },
    ]);
  });

  test("an access mode does not leak into the next descriptor", () => {
    // lsof emits no `a` field for some entries. Inheriting the previous one would mark a read-only
    // descriptor writable and let a reader be mistaken for the shell that owns the capture.
    const text = `p1\nf1\naw\nn/tmp/written\nf3\nn/tmp/unknown\n`;
    expect(parseLsofDescriptors(text)).toEqual([
      { pid: 1, fd: "1", access: "w", name: "/tmp/written" },
      { pid: 1, fd: "3", access: "", name: "/tmp/unknown" },
    ]);
  });

  test("the space lsof emits for cwd and txt entries reads as no access", () => {
    expect(parseLsofDescriptors(`p1\nfcwd\na \nn/tmp/here\n`)).toEqual([
      { pid: 1, fd: "cwd", access: "", name: "/tmp/here" },
    ]);
  });

  test("empty output is no descriptors, not a throw", () => {
    expect(parseLsofDescriptors("")).toEqual([]);
  });
});

describe("taskShellsFromDescriptors", () => {
  test("recovers the task id from the descriptor itself", () => {
    const shells = taskShellsFromDescriptors([
      { pid: 63854, fd: "1", access: "w", name: CAPTURE },
    ]);
    expect(shells).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
  });

  test("fd 2 does not report the same task a second time", () => {
    // Both descriptors point at the same capture file; counting stderr would double every task.
    const shells = taskShellsFromDescriptors([
      { pid: 63854, fd: "1", access: "w", name: CAPTURE },
      { pid: 63854, fd: "2", access: "w", name: CAPTURE },
    ]);
    expect(shells).toHaveLength(1);
  });

  test("a capture on a saved descriptor still names its task", () => {
    // The regression. `{ … } > results/bakeoff.log 2>&1` puts the redirect on fd 1 and moves the
    // harness's capture to fds 12 and 14, exactly as measured on a live run. Keying off fd 1 read
    // this shell as running nothing, and the panel showed a four-minute-old task as finished with
    // an unknown outcome.
    const shells = taskShellsFromDescriptors([
      { pid: 33824, fd: "1", access: "w", name: "/Users/dev/work/harbor/results/bakeoff.log" },
      { pid: 33824, fd: "2", access: "w", name: "/Users/dev/work/harbor/results/bakeoff.log" },
      { pid: 33824, fd: "12", access: "w", name: CAPTURE },
      { pid: 33824, fd: "14", access: "w", name: CAPTURE },
    ]);
    expect(shells).toEqual([{ taskId: "bukxtjy7e", pid: 33824, capturePath: CAPTURE }]);
  });

  test("a process only reading a capture is not its shell", () => {
    // The agent's own `cat` on a finished task's output. Counting it would resurrect that task as
    // running, which is the false positive accepting every descriptor number opens up.
    expect(taskShellsFromDescriptors([{ pid: 700, fd: "3", access: "r", name: CAPTURE }]))
      .toEqual([]);
  });

  test("a capture path outside the task root is refused", () => {
    // The fence. Everything opened is discovered, so this is the check that a discovered path is
    // somewhere we are willing to read.
    const shells = taskShellsFromDescriptors([
      { pid: 1, fd: "1", access: "w", name: "/Users/dev/.ssh/tasks/bevil0000.output" },
    ]);
    expect(shells).toEqual([]);
  });

  test("ordinary files the shell happens to hold are ignored", () => {
    expect(taskShellsFromDescriptors([{ pid: 1, fd: "1", access: "w", name: "/dev/null" }]))
      .toEqual([]);
  });
});

describe("taskShellsByOwner", () => {
  /** Rows of the shared table: the children of `ppid`, as `ps -eo` would report them. */
  const childrenOf = (ppid: number, pids: readonly number[]): ProcessRow[] =>
    pids.map((pid) => ({ pid, ppid, startedAt: 0, cpuMs: 0, command: "zsh" }));

  test("finds the running task among a session's other children", async () => {
    // A real session's children are mostly MCP servers and a language server.
    const run = fakeRunner({
      "/usr/sbin/lsof -p 61794,61796,63854 -F pfan":
        `p61794\nf1\naw\nn/dev/null\np63854\nf1\naw\nn${CAPTURE}\nf2\naw\nn${CAPTURE}\n`,
    });
    const shells = await taskShellsByOwner(run, [61308], childrenOf(61308, [61794, 61796, 63854]));
    expect(shells.get(61308)).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
  });

  test("several sessions are answered by ONE lsof, each keeping its own shells", async () => {
    // The point of the batch. A wall of open sessions used to fork lsof once per session per tick,
    // and it is the most expensive probe in this module.
    let forks = 0;
    let asked: readonly string[] = [];
    const run: CommandRunner = async (argv) => {
      forks += 1;
      asked = argv;
      return `p63854\nf1\naw\nn${CAPTURE}\np71001\nf1\naw\nn${OTHER_CAPTURE}\n`;
    };
    const table = [...childrenOf(61308, [63854]), ...childrenOf(70000, [71001])];
    const shells = await taskShellsByOwner(run, [61308, 70000], table);
    expect(forks).toBe(1);
    expect(asked).toEqual(["/usr/sbin/lsof", "-p", "63854,71001", "-F", "pfan"]);
    expect(shells.get(61308)).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
    expect(shells.get(70000)).toEqual([{ taskId: "bother999", pid: 71001, capturePath: OTHER_CAPTURE }]);
  });

  test("takes only the asked-for owners' children, not every process in the table", async () => {
    // The table is the whole machine. A shell under some other parent belongs to that parent's
    // session, and widening the call must not widen who a task is attributed to.
    let asked: readonly string[] = [];
    const run: CommandRunner = async (argv) => {
      asked = argv;
      return `p63854\nf1\naw\nn${CAPTURE}\n`;
    };
    const table = [...childrenOf(61308, [63854]), ...childrenOf(99999, [63855])];
    const shells = await taskShellsByOwner(run, [61308], table);
    expect(asked).toEqual(["/usr/sbin/lsof", "-p", "63854", "-F", "pfan"]);
    expect([...shells.keys()]).toEqual([61308]);
  });

  test("asks for every descriptor, not a range", async () => {
    // A range is a guess at where zsh parks a saved descriptor, and guessing wrong fails silently
    // as "this session is running nothing".
    let asked: readonly string[] = [];
    const run: CommandRunner = async (argv) => {
      asked = argv;
      return `p63854\nf12\naw\nn${CAPTURE}\n`;
    };
    const shells = await taskShellsByOwner(run, [61308], childrenOf(61308, [63854]));
    expect(asked).toEqual(["/usr/sbin/lsof", "-p", "63854", "-F", "pfan"]);
    expect(shells.get(61308)).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
  });

  test("owners with no children run no tasks and spawn nothing at all", async () => {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      return "";
    };
    expect(await taskShellsByOwner(run, [999], childrenOf(61308, [63854]))).toEqual(new Map());
    expect(calls).toBe(0);
  });

  test("a descriptor for a pid nobody asked about is dropped, not attributed", async () => {
    // lsof was given an explicit list, so this should not happen -- and if it does, reporting one
    // session's task as another's is worse than reporting nothing.
    const run: CommandRunner = async () => `p55555\nf1\naw\nn${CAPTURE}\n`;
    const shells = await taskShellsByOwner(run, [61308], childrenOf(61308, [63854]));
    expect(shells.size).toBe(0);
  });
});

describe("outputTargetsOf", () => {
  const shell = { taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE };

  test("finds the redirect target the stdout capture does not show", async () => {
    // The whole point: the capture is 0 bytes because the command redirected, and the work is
    // going to a log file a descendant holds open.
    const run = fakeRunner({
      "/bin/ps -eo pid=,ppid=,lstart=,time=,command=":
        `63854 1 Mon Aug 17 01:02:03 2026 0:00.02 /bin/zsh -c x\n63891 63854 Mon Aug 17 01:02:03 2026 0:00.01 make all\n`,
      "/usr/sbin/lsof -p 63891 -a -d 1 -F pfan": `p63891\nf1\naw\nn${REAL_LOG}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([REAL_LOG]);
  });

  test("a target held by both a subshell and its child is reported once", async () => {
    // Observed in the live smoke, where it rendered the same log twice.
    const run = fakeRunner({
      "/bin/ps -eo pid=,ppid=,lstart=,time=,command=":
        `63854 1 Mon Aug 17 01:02:03 2026 0:00.02 /bin/zsh -c x\n` +
        `63891 63854 Mon Aug 17 01:02:03 2026 0:00.01 sh -c make\n` +
        `63892 63891 Mon Aug 17 01:02:04 2026 0:00.03 make all\n`,
      "/usr/sbin/lsof -p 63891,63892 -a -d 1 -F pfan": `p63891\nf1\naw\nn${REAL_LOG}\np63892\nf1\naw\nn${REAL_LOG}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([REAL_LOG]);
  });

  test("the capture itself is not reported as a redirect target", async () => {
    const run = fakeRunner({
      "/bin/ps -eo pid=,ppid=,lstart=,time=,command=":
        `63854 1 Mon Aug 17 01:02:03 2026 0:00.02 /bin/zsh -c x\n63891 63854 Mon Aug 17 01:02:03 2026 0:00.01 make all\n`,
      "/usr/sbin/lsof -p 63891 -a -d 1 -F pfan": `p63891\nf1\naw\nn${CAPTURE}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([]);
  });

  test("a task that streams normally has no separate target", async () => {
    // No descendants at all: the shell itself is doing the work, so there is nowhere else to look.
    const run = fakeRunner({
      "/bin/ps -eo pid=,ppid=,lstart=,time=,command=":
        `63854 1 Mon Aug 17 01:02:03 2026 0:00.02 /bin/zsh -c x\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([]);
  });
});
