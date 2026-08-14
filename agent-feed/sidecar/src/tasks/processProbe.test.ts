import { describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import {
  type CommandRunner,
  outputTargetsOf,
  parseLsofDescriptors,
  taskShellsFromDescriptors,
  taskShellsOf,
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
    // Real shape from `lsof -F pfn`: stateful, one field per line.
    const text = `p63854\nf1\nn${CAPTURE}\nf2\nn${CAPTURE}\np63891\nf1\nn${REAL_LOG}\n`;
    expect(parseLsofDescriptors(text)).toEqual([
      { pid: 63854, fd: "1", name: CAPTURE },
      { pid: 63854, fd: "2", name: CAPTURE },
      { pid: 63891, fd: "1", name: REAL_LOG },
    ]);
  });

  test("a name arriving before any descriptor is dropped rather than misattributed", () => {
    expect(parseLsofDescriptors(`n/tmp/orphan\np1\nf1\nn/tmp/kept\n`)).toEqual([
      { pid: 1, fd: "1", name: "/tmp/kept" },
    ]);
  });

  test("empty output is no descriptors, not a throw", () => {
    expect(parseLsofDescriptors("")).toEqual([]);
  });
});

describe("taskShellsFromDescriptors", () => {
  test("recovers the task id from the descriptor itself", () => {
    const shells = taskShellsFromDescriptors([{ pid: 63854, fd: "1", name: CAPTURE }]);
    expect(shells).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
  });

  test("fd 2 does not report the same task a second time", () => {
    // Both descriptors point at the same capture file; counting stderr would double every task.
    const shells = taskShellsFromDescriptors([
      { pid: 63854, fd: "1", name: CAPTURE },
      { pid: 63854, fd: "2", name: CAPTURE },
    ]);
    expect(shells).toHaveLength(1);
  });

  test("a capture path outside the task root is refused", () => {
    // The fence. Everything opened is discovered, so this is the check that a discovered path is
    // somewhere we are willing to read.
    const shells = taskShellsFromDescriptors([
      { pid: 1, fd: "1", name: "/Users/dev/.ssh/tasks/bevil0000.output" },
    ]);
    expect(shells).toEqual([]);
  });

  test("ordinary files the shell happens to hold are ignored", () => {
    expect(taskShellsFromDescriptors([{ pid: 1, fd: "1", name: "/dev/null" }])).toEqual([]);
  });
});

describe("taskShellsOf", () => {
  test("finds the running task among a session's other children", () => {
    // A real session's children are mostly MCP servers and a language server.
    const run = fakeRunner({
      "pgrep -P 61308": "61794\n61796\n63854\n",
      "lsof -p 61794,61796,63854 -a -d 0-3 -F pfn":
        `p61794\nf1\nn/dev/null\np63854\nf1\nn${CAPTURE}\nf2\nn${CAPTURE}\n`,
    });
    return taskShellsOf(run, 61308).then((shells) => {
      expect(shells).toEqual([{ taskId: "bukxtjy7e", pid: 63854, capturePath: CAPTURE }]);
    });
  });

  test("a session with no children runs no tasks and spawns no lsof", async () => {
    let calls = 0;
    const run: CommandRunner = async (argv) => {
      calls += 1;
      expect(argv[0]).toBe("pgrep");
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
      "pgrep -P 63854": "63891\n",
      "pgrep -P 63891": "",
      "lsof -p 63891 -a -d 1 -F pfn": `p63891\nf1\nn${REAL_LOG}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([REAL_LOG]);
  });

  test("a target held by both a subshell and its child is reported once", async () => {
    // Observed in the live smoke, where it rendered the same log twice.
    const run = fakeRunner({
      "pgrep -P 63854": "63891\n",
      "pgrep -P 63891": "63892\n",
      "pgrep -P 63892": "",
      "lsof -p 63891,63892 -a -d 1 -F pfn": `p63891\nf1\nn${REAL_LOG}\np63892\nf1\nn${REAL_LOG}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([REAL_LOG]);
  });

  test("the capture itself is not reported as a redirect target", async () => {
    const run = fakeRunner({
      "pgrep -P 63854": "63891\n",
      "pgrep -P 63891": "",
      "lsof -p 63891 -a -d 1 -F pfn": `p63891\nf1\nn${CAPTURE}\n`,
    });
    expect(await outputTargetsOf(run, shell)).toEqual([]);
  });

  test("a task that streams normally has no separate target", async () => {
    const run = fakeRunner({ "pgrep -P 63854": "" });
    expect(await outputTargetsOf(run, shell)).toEqual([]);
  });
});
