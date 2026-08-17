import { describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import {
  type CommandRunner,
  outputTargetsOf,
  parseLsofDescriptors,
  parseShellDetails,
  shellDetailsOf,
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
      "/usr/bin/pgrep -P 63854": "63891\n",
      "/usr/bin/pgrep -P 63891": "",
      "/usr/sbin/lsof -p 63891 -a -d 1 -F pfan": `p63891\nf1\naw\nn${REAL_LOG}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([REAL_LOG]);
  });

  test("a target held by both a subshell and its child is reported once", async () => {
    // Observed in the live smoke, where it rendered the same log twice.
    const run = fakeRunner({
      "/usr/bin/pgrep -P 63854": "63891\n",
      "/usr/bin/pgrep -P 63891": "63892\n",
      "/usr/bin/pgrep -P 63892": "",
      "/usr/sbin/lsof -p 63891,63892 -a -d 1 -F pfan": `p63891\nf1\naw\nn${REAL_LOG}\np63892\nf1\naw\nn${REAL_LOG}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([REAL_LOG]);
  });

  test("the capture itself is not reported as a redirect target", async () => {
    const run = fakeRunner({
      "/usr/bin/pgrep -P 63854": "63891\n",
      "/usr/bin/pgrep -P 63891": "",
      "/usr/sbin/lsof -p 63891 -a -d 1 -F pfan": `p63891\nf1\naw\nn${CAPTURE}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([]);
  });

  test("a task that streams normally has no separate target", async () => {
    const run = fakeRunner({ "/usr/bin/pgrep -P 63854": "" });
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

  test("an interior quote survives zsh's escaping", () => {
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

describe("parseShellDetails", () => {
  test("splits pid, ctime, and a command full of spaces", () => {
    // Real shape: `ps` right-pads lstart, so the command does not start at a fixed column.
    const line = `54161 Mon Aug 17 00:35:26 2026     ${WRAPPER}`;
    expect(parseShellDetails(line)).toEqual([{
      pid: 54161,
      startedAt: new Date(2026, 7, 17, 0, 35, 26).getTime(),
      command: "sleep 30 > /dev/null 2>&1",
    }]);
  });

  test("a process that exited between the pgrep and the ps is skipped, not guessed", () => {
    expect(parseShellDetails("\n  \n")).toEqual([]);
  });

  test("a line whose clock will not parse is dropped rather than dated to now", () => {
    expect(parseShellDetails("100 not a real timestamp here /bin/zsh -c make")).toEqual([]);
  });
});

describe("shellDetailsOf", () => {
  test("no unaccounted shells means no fork at all", async () => {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      return "";
    };
    expect(await shellDetailsOf(run, [])).toEqual(new Map());
    expect(calls).toBe(0);
  });

  test("asks ps once for the whole set and keys the answer by pid", async () => {
    let asked: readonly string[] = [];
    const run: CommandRunner = async (argv) => {
      asked = argv;
      return `100 Mon Aug 17 00:35:26 2026 /bin/zsh -c eval 'make all' < /dev/null && pwd -P\n` +
        `101 Mon Aug 17 00:35:30 2026 /bin/zsh -c eval 'make test' < /dev/null && pwd -P\n`;
    };
    const details = await shellDetailsOf(run, [100, 101]);
    expect(asked).toEqual(["/bin/ps", "-p", "100,101", "-o", "pid=,lstart=,command="]);
    expect(details.get(100)?.command).toBe("make all");
    expect(details.get(101)?.command).toBe("make test");
  });
});
