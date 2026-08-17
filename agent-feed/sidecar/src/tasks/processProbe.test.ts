import { describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import {
  busiestDescendant,
  type CommandRunner,
  descendantsOf,
  matchShellsByCommand,
  outputTargetsOf,
  parseCpuTime,
  parseLsofDescriptors,
  parseProcessTable,
  shellDetailFrom,
  taskShellsFromDescriptors,
  taskShellsOf,
  unwrapShellCommand,
} from "./processProbe.ts";

const ROOT = config.claudeTaskRoot;
const SESSION = "895eadd3-2049-4e2f-9989-d30d0a90eb46";
const CAPTURE = `${ROOT}/-private-tmp/${SESSION}/tasks/bukxtjy7e.output`;
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

describe("taskShellsOf", () => {
  test("finds the running task among a session's other children", () => {
    // A real session's children are mostly MCP servers and a language server.
    const run = fakeRunner({
      "/usr/bin/pgrep -P 61308": "61794\n61796\n63854\n",
      "/usr/sbin/lsof -p 61794,61796,63854 -F pfan":
        `p61794\nf1\naw\nn/dev/null\np63854\nf1\naw\nn${CAPTURE}\nf2\naw\nn${CAPTURE}\n`,
    });
    return taskShellsOf(run, 61308).then((shells) => {
      expect(shells).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
    });
  });

  test("asks for every descriptor, not a range", async () => {
    // A range is a guess at where zsh parks a saved descriptor, and guessing wrong fails silently
    // as "this session is running nothing".
    let asked: readonly string[] = [];
    const run: CommandRunner = async (argv) => {
      if (argv[0] === "/usr/bin/pgrep") return "63854\n";
      asked = argv;
      return `p63854\nf12\naw\nn${CAPTURE}\n`;
    };
    const shells = await taskShellsOf(run, 61308);
    expect(asked).toEqual(["/usr/sbin/lsof", "-p", "63854", "-F", "pfan"]);
    expect(shells).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
  });

  test("a session with no children runs no tasks and spawns no lsof", async () => {
    let calls = 0;
    const run: CommandRunner = async (argv) => {
      calls += 1;
      expect(argv[0]).toBe("/usr/bin/pgrep");
      return "";
    };
    expect(await taskShellsOf(run, 999)).toEqual([]);
    expect(calls).toBe(1);
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

// The harness's real wrapper, copied from `ps -o command=` on a live task shell rather than
// imagined. Everything before `eval` is preamble the viewer must never be shown.
const WRAPPER = "/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1786939825162-fgn1dk.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'sleep 30 > /dev/null 2>&1' < /dev/null && pwd -P >| /tmp/claude-9b7a-cwd";

describe("unwrapShellCommand", () => {
  test("recovers the agent's command from the harness wrapper", () => {
    expect(unwrapShellCommand(WRAPPER)).toBe("sleep 30 > /dev/null 2>&1");
  });

  test("an interior quote survives the harness's splice, in the form it actually emits", () => {
    // Measured: the harness spells an embedded single quote `'"'"'`, and a live watcher's python
    // filter containing `line.startswith('{')` came back 88 characters longer than the transcript's
    // copy until this was handled -- so every comparison against that command failed silently.
    const argv = `/bin/zsh -c eval 'if not line.startswith('"'"'{'"'"'): continue' < /dev/null && pwd -P`;
    expect(unwrapShellCommand(argv)).toBe("if not line.startswith('{'): continue");
  });

  test("the other standard spelling of the same splice also works", () => {
    const argv = `/bin/zsh -c eval 'echo '\\''hi there'\\''' < /dev/null && pwd -P`;
    expect(unwrapShellCommand(argv)).toBe("echo 'hi there'");
  });

  test("a multi-line command keeps its newlines", () => {
    // `.` does not cross a newline without the s flag, and a heredoc or a for-loop is exactly the
    // kind of long command worth showing.
    const argv = "/bin/zsh -c eval 'for m in a b; do\n  echo $m\ndone' < /dev/null && pwd -P";
    expect(unwrapShellCommand(argv)).toBe("for m in a b; do\n  echo $m\ndone");
  });

  test("an unrecognised wrapper yields the whole argv rather than nothing", () => {
    // The wrapper is an undocumented harness artifact. When it moves, an ugly row beats a blank
    // one -- the viewer can still read what is running.
    expect(unwrapShellCommand("  /bin/zsh -c make all  ")).toBe("/bin/zsh -c make all");
  });
});

describe("parseCpuTime", () => {
  test("macOS minutes are unbounded, not rolled into hours", () => {
    // Real: a long-lived daemon reads `4318:19.61`. Treating the first field as hours would
    // report 4318 hours of CPU and make every activity line absurd.
    expect(parseCpuTime("4318:19.61")).toBe((4318 * 60 + 19.61) * 1000);
    expect(parseCpuTime("0:00.02")).toBe(20);
  });

  test("an hours field is tolerated in case the format grows one", () => {
    expect(parseCpuTime("1:02:03")).toBe((3600 + 123) * 1000);
  });

  test("garbage is null rather than NaN propagating into the wire", () => {
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("-")).toBeNull();
    expect(parseCpuTime("1:2:3:4")).toBeNull();
  });
});

// Real `ps -eo pid=,ppid=,lstart=,time=,command=` shape, columns right-padded as ps pads them.
const TABLE = [
  "    1     0 Wed Jul 29 19:40:49 2026     283:15.55 /sbin/launchd",
  " 7680 38081 Mon Aug 17 01:02:03 2026       0:00.02 /bin/zsh -c eval 'node build.ts | tail -16' < /dev/null && pwd -P",
  " 7717  7680 Mon Aug 17 01:02:03 2026       0:00.01 /bin/zsh -c node build.ts",
  " 7718  7717 Mon Aug 17 01:02:04 2026       1:23.45 node build.ts",
  " 7719  7680 Mon Aug 17 01:02:03 2026       0:00.00 tail -16",
].join("\n");

describe("parseProcessTable", () => {
  test("splits the fixed leading fields and keeps the command whole", () => {
    const rows = parseProcessTable(TABLE);
    expect(rows).toHaveLength(5);
    expect(rows[3]).toEqual({
      pid: 7718,
      ppid: 7717,
      startedAt: new Date(2026, 7, 17, 1, 2, 4).getTime(),
      cpuMs: 83_450,
      command: "node build.ts",
    });
  });

  test("a task shell's argv is left wrapped here and unwrapped only where it is shown", () => {
    // The table is the raw kernel answer. Unwrapping belongs to the shell-detail lookup, so a
    // descendant's argv is never accidentally put through a wrapper stripper meant for shells.
    expect(parseProcessTable(TABLE)[1]?.command).toContain("eval 'node build.ts | tail -16'");
  });

  test("a truncated or headerless line is skipped rather than half-parsed", () => {
    expect(parseProcessTable("garbage\n  \n123 456 nope")).toEqual([]);
  });
});

describe("descendantsOf", () => {
  test("collects the whole tree, not just direct children", () => {
    const pids = descendantsOf(parseProcessTable(TABLE), 7680).map((row) => row.pid).sort();
    expect(pids).toEqual([7717, 7718, 7719]);
  });

  test("a leaf has no descendants and the walk terminates", () => {
    expect(descendantsOf(parseProcessTable(TABLE), 7719)).toEqual([]);
  });

  test("a self-parenting row cannot spin the walk forever", () => {
    // Not possible in a real table, but a pid reused between the ps snapshot and this walk could
    // fake one, and an unbounded loop inside a 2s poll does not recover.
    const rows = parseProcessTable(" 500   500 Mon Aug 17 01:02:03 2026       0:00.01 /bin/zsh");
    expect(descendantsOf(rows, 500)).toEqual([]);
  });
});

describe("busiestDescendant", () => {
  test("names the step doing the work, not the plumbing around it", () => {
    // The whole point: in `node build.ts | tail -16` the wrapper shell and `tail` sit at zero
    // while node climbs, so CPU picks node without needing to know which is which.
    expect(busiestDescendant(parseProcessTable(TABLE), 7680)?.command).toBe("node build.ts");
  });

  test("with no CPU burned anywhere, the most recent process wins", () => {
    // A pipeline of sleeps. Any of them is true; the newest is the one that just started.
    const rows = parseProcessTable([
      " 600   500 Mon Aug 17 01:02:03 2026       0:00.00 sleep 100",
      " 601   500 Mon Aug 17 01:02:09 2026       0:00.00 sleep 200",
    ].join("\n"));
    expect(busiestDescendant(rows, 500)?.pid).toBe(601);
  });

  test("a task with no descendants reports nothing rather than itself", () => {
    // Normal for a command that has just started, and final for one done in the shell itself.
    // Reporting the shell would show the viewer the harness's preamble as the current step.
    expect(busiestDescendant(parseProcessTable(TABLE), 7719)).toBeNull();
  });
});

describe("shellDetailFrom", () => {
  test("unwraps the harness preamble for a shell in the table", () => {
    expect(shellDetailFrom(parseProcessTable(TABLE), 7680)).toEqual({
      pid: 7680,
      startedAt: new Date(2026, 7, 17, 1, 2, 3).getTime(),
      command: "node build.ts | tail -16",
    });
  });

  test("a pid that exited between the lsof and the ps is null, not a guess", () => {
    expect(shellDetailFrom(parseProcessTable(TABLE), 99_999)).toBeNull();
  });
});

describe("matchShellsByCommand", () => {
  const WATCH = 'tail -f /tmp/run20.log | python3 -u -c "\nimport json,sys\nprint(1)"';
  const ARGV = WATCH.replaceAll("\n", "\\012");
  const rows = (lines: string[]) => parseProcessTable(lines.join("\n"));

  test("sees through ps's octal escaping of a multi-line command", () => {
    // Without this the join never matches: a Monitor's command routinely embeds a script, and ps
    // renders every newline in it as a literal \012.
    const table = rows([`900 500 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`]);
    const matched = matchShellsByCommand(table, 500, [{ key: "m1", command: WATCH, startedAt: null }]);
    expect(matched.get("m1")?.pid).toBe(900);
  });

  test("only the named parent's children are candidates", () => {
    // Command alone is not identity across the machine: another session running the same watcher
    // would otherwise answer for this one.
    const table = rows([`900 999 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`]);
    expect(matchShellsByCommand(table, 500, [{ key: "m1", command: WATCH, startedAt: null }]).size)
      .toBe(0);
  });

  test("a shell is claimed once, and the closest start time wins it", () => {
    const table = rows([
      `900 500 Mon Aug 17 01:00:00 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`,
      `901 500 Mon Aug 17 01:05:00 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`,
    ]);
    const matched = matchShellsByCommand(table, 500, [
      { key: "new", command: WATCH, startedAt: new Date(2026, 7, 17, 1, 5, 0).getTime() },
      { key: "old", command: WATCH, startedAt: new Date(2026, 7, 17, 1, 0, 0).getTime() },
    ]);
    expect(matched.get("new")?.pid).toBe(901);
    expect(matched.get("old")?.pid).toBe(900);
  });

  test("no live shell running that command yields no entry, not a wrong one", () => {
    const table = rows([`900 500 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval 'something else' < /dev/null`]);
    expect(matchShellsByCommand(table, 500, [{ key: "m1", command: WATCH, startedAt: null }]).size)
      .toBe(0);
  });
});
