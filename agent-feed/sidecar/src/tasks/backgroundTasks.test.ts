import { describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { assembleSnapshot, type SnapshotSources } from "./backgroundTasks.ts";
import { parseProcessTable } from "./processProbe.ts";
import type { TaskIdentity } from "./taskIdentity.ts";
import type { TaskNotification } from "./taskState.ts";

const NOW = Date.UTC(2026, 7, 14, 18, 0, 0);
const ROOT = config.claudeTaskRoot;

/**
 * The local-time ctime string `ps -o lstart=` would print for an instant.
 *
 * Built rather than hardcoded so these tests hold in any timezone, not only the one they were
 * written in -- the same reason `liveSessionProcesses`' tests build theirs.
 */
function stamp(at: number): string {
  const date = new Date(at);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
}

/** Process rows from the same `ps` text the live probe parses, so fixtures cannot drift from it. */
const table = parseProcessTable;

function identity(taskId: string, overrides: Partial<TaskIdentity> = {}): TaskIdentity {
  return {
    taskId,
    description: `run ${taskId}`,
    command: `echo ${taskId}`,
    startedAt: NOW - 60_000,
    capturePath: `${ROOT}/-p/s/tasks/${taskId}.output`,
    ...overrides,
  };
}

function sources(overrides: Partial<SnapshotSources> = {}): SnapshotSources {
  return {
    shells: [],
    identities: new Map(),
    notifications: new Map(),
    markers: new Map(),
    captureSizes: new Map(),
    processes: [],
    uncorroboratedAfterMs: 5000,
    ownerAlive: true,
    now: NOW,
    ...overrides,
  };
}

describe("assembleSnapshot", () => {
  test("a shell holding an output file is running, with elapsed time", () => {
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "b1", pid: 100, capturePath: `${ROOT}/-p/s/tasks/b1.output` }],
      identities: new Map([["b1", identity("b1")]]),
      captureSizes: new Map([["b1", 4096]]),
    }));
    expect(snapshot.running).toEqual([{
      taskId: "b1",
      kind: "bash",
      description: "run b1",
      command: "echo b1",
      startedAt: NOW - 60_000,
      state: { status: "running" },
      elapsedMs: 60_000,
      hasOutput: true,
      corroborated: true,
      activity: null,
    }]);
    expect(snapshot.finished).toEqual([]);
  });

  test("a killed task is finished even though the transcript never said so", () => {
    // The measured failure of transcript-only detection: no completion record is ever written for
    // a kill, so this task would otherwise read as running forever.
    const snapshot = assembleSnapshot(sources({
      identities: new Map([["b1", identity("b1")]]),
      markers: new Map([["b1", { status: "killed" }]]),
    }));
    expect(snapshot.running).toEqual([]);
    expect(snapshot.finished[0]).toMatchObject({ taskId: "b1", state: { status: "killed" } });
  });

  test("the kernel outranks a completion notification", () => {
    // A stale notification must not retire a task the kernel says is still holding its output.
    const notification: TaskNotification = {
      kind: "completion",
      taskId: "b1",
      status: "completed",
      summary: "done",
      exitCode: 0,
      taskKind: "bash",
    };
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "b1", pid: 100, capturePath: `${ROOT}/-p/s/tasks/b1.output` }],
      identities: new Map([["b1", identity("b1")]]),
      notifications: new Map([["b1", notification]]),
    }));
    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.finished).toEqual([]);
  });

  test("a redirected task is running with no readable capture", () => {
    // Zero-byte capture is exactly the case rendered elsewhere as "No output yet". It is still
    // running, and the stream resolves its real target separately.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "b1", pid: 100, capturePath: `${ROOT}/-p/s/tasks/b1.output` }],
      identities: new Map([["b1", identity("b1")]]),
      captureSizes: new Map([["b1", 0]]),
    }));
    expect(snapshot.running[0]).toMatchObject({ hasOutput: false, state: { status: "running" } });
  });

  test("a Monitor that has only ticked is neither running nor finished", () => {
    // It has not ended, and nothing holds an output file for it. Listing it under finished would
    // claim an ending that has not happened.
    const snapshot = assembleSnapshot(sources({
      notifications: new Map<string, TaskNotification>([
        ["b3xj3ww32", { kind: "progress", taskId: "b3xj3ww32", summary: "Monitor event" }],
      ]),
    }));
    expect(snapshot.running).toEqual([]);
    expect(snapshot.finished).toEqual([]);
  });

  test("a young uncorroborated shell is a foreground command, not a background task", () => {
    // Caught against a live sidecar: the agent's own in-flight `curl` showed up as a running task.
    // The harness gives foreground commands a tasks/<id>.output file too and their shells hold it
    // open identically, so the kernel cannot tell them apart. Under the threshold, the transcript
    // is still the only thing that can say "backgrounded", and it says nothing.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "bcurl", pid: 100, capturePath: `${ROOT}/-p/s/tasks/bcurl.output` }],
      processes: table(`100 1 ${stamp(NOW - 200)} 0:00.01 /bin/zsh -c eval 'curl -s https://x' < /dev/null`),
    }));
    expect(snapshot.running).toEqual([]);
    expect(snapshot.finished).toEqual([]);
  });

  test("an uncorroborated shell that has outlived the threshold is shown, and marked", () => {
    // The promoted-task case. A command moved to the background after it started never gets a
    // `run_in_background` in its tool_use, and the tool_result naming its task id does not exist
    // until it ends -- so nothing on disk corroborates it for its whole life. Elapsed time is the
    // only separator there is, and the row says as much rather than posing as a declared task.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "bpromoted", pid: 100, capturePath: `${ROOT}/-p/s/tasks/bpromoted.output` }],
      processes: table(`100 1 ${stamp(NOW - 360_000)} 0:00.01 /bin/zsh -c eval 'python3 run.py --model flash' < /dev/null`),
    }));
    expect(snapshot.running).toEqual([{
      taskId: "bpromoted",
      kind: "bash",
      // No agent description exists for this one, so the command line stands in for it.
      description: "python3 run.py --model flash",
      command: "python3 run.py --model flash",
      startedAt: NOW - 360_000,
      state: { status: "running" },
      elapsedMs: 360_000,
      hasOutput: false,
      corroborated: false,
      activity: null,
    }]);
  });

  test("an uncorroborated shell whose start time is unknown is not shown at age zero", () => {
    // Without the kernel's clock there is nothing to measure the threshold against. Showing it
    // anyway would defeat the threshold entirely for exactly the shells we know least about.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "bmystery", pid: 100, capturePath: `${ROOT}/-p/s/tasks/bmystery.output` }],
    }));
    expect(snapshot.running).toEqual([]);
  });

  test("one foreground shell does not suppress a real task running beside it", () => {
    const snapshot = assembleSnapshot(sources({
      shells: [
        { taskId: "bforeground", pid: 100, capturePath: `${ROOT}/-p/s/tasks/bforeground.output` },
        { taskId: "b1", pid: 101, capturePath: `${ROOT}/-p/s/tasks/b1.output` },
      ],
      identities: new Map([["b1", identity("b1")]]),
      processes: table(`100 1 ${stamp(NOW - 200)} 0:00.01 /bin/zsh -c eval 'grep -r x .' < /dev/null`),
    }));
    expect(snapshot.running.map((task) => task.taskId)).toEqual(["b1"]);
  });

  test("a corroborated task is shown immediately, with no threshold to wait out", () => {
    // The threshold exists only because uncorroborated shells are ambiguous. A declared one is
    // not, so making it wait would be a regression dressed as consistency.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "b1", pid: 100, capturePath: `${ROOT}/-p/s/tasks/b1.output` }],
      identities: new Map([["b1", identity("b1", { startedAt: NOW - 10 })]]),
      uncorroboratedAfterMs: 60_000,
    }));
    expect(snapshot.running.map((task) => task.taskId)).toEqual(["b1"]);
  });

  test("a start with no evidence at all resolves as unknown, not running", () => {
    // The reaped case. Counting it as running would inflate the chip forever.
    const snapshot = assembleSnapshot(sources({ identities: new Map([["b1", identity("b1")]]) }));
    expect(snapshot.finished[0]).toMatchObject({ state: { status: "unknown" } });
  });

  test("longest-running task sorts first", () => {
    const snapshot = assembleSnapshot(sources({
      shells: [
        { taskId: "young", pid: 1, capturePath: `${ROOT}/-p/s/tasks/young.output` },
        { taskId: "old", pid: 2, capturePath: `${ROOT}/-p/s/tasks/old.output` },
      ],
      identities: new Map([
        ["young", identity("young", { startedAt: NOW - 5_000 })],
        ["old", identity("old", { startedAt: NOW - 900_000 })],
      ]),
    }));
    expect(snapshot.running.map((task) => task.taskId)).toEqual(["old", "young"]);
  });

  test("a dead owner reports ownerAlive false rather than an ambiguous empty list", () => {
    const snapshot = assembleSnapshot(sources({ ownerAlive: false }));
    expect(snapshot).toEqual({ running: [], finished: [], ownerAlive: false });
  });
});

describe("assembleSnapshot activity", () => {
  const CAPTURE = `${ROOT}/-p/s/tasks/b1.output`;

  test("names the step doing the work inside a pipeline that writes nothing", () => {
    // The case this exists for. `node build.ts 2>&1 | tail -16` keeps its output in a kernel pipe
    // and in tail's memory, so the capture stays empty for the whole run and there are no bytes to
    // say whether it is working or hung. The tree still answers.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "b1", pid: 700, capturePath: CAPTURE }],
      identities: new Map([["b1", identity("b1")]]),
      processes: table([
        `700 1   ${stamp(NOW - 300_000)} 0:00.02 /bin/zsh -c eval 'node build.ts | tail -16' < /dev/null`,
        `701 700 ${stamp(NOW - 300_000)} 0:00.01 /bin/zsh -c node build.ts`,
        `702 701 ${stamp(NOW - 299_000)} 1:23.45 node build.ts`,
        `703 700 ${stamp(NOW - 300_000)} 0:00.00 tail -16`,
      ].join("\n")),
    }));
    expect(snapshot.running[0]?.activity).toEqual({
      pid: 702,
      command: "node build.ts",
      cpuMs: 83_450,
      elapsedMs: 299_000,
    });
  });

  test("a task with no descendants reports no activity rather than its own shell", () => {
    // Showing the shell would put the harness's preamble in front of the viewer as "the current
    // step", which is worse than saying nothing.
    const snapshot = assembleSnapshot(sources({
      shells: [{ taskId: "b1", pid: 700, capturePath: CAPTURE }],
      identities: new Map([["b1", identity("b1")]]),
      processes: table(`700 1 ${stamp(NOW - 1000)} 0:00.02 /bin/zsh -c eval 'sleep 60' < /dev/null`),
    }));
    expect(snapshot.running[0]?.activity).toBeNull();
  });

  test("one task's tree is never reported as another's", () => {
    // Two tasks in flight is the ordinary case, and attributing one's step to the other would be
    // the exact class of error the fd join was built to avoid.
    const snapshot = assembleSnapshot(sources({
      shells: [
        { taskId: "b1", pid: 700, capturePath: CAPTURE },
        { taskId: "b2", pid: 800, capturePath: `${ROOT}/-p/s/tasks/b2.output` },
      ],
      identities: new Map([["b1", identity("b1")], ["b2", identity("b2")]]),
      processes: table([
        `700 1   ${stamp(NOW - 9000)} 0:00.02 /bin/zsh -c eval 'a' < /dev/null`,
        `701 700 ${stamp(NOW - 9000)} 0:10.00 cargo build`,
        `800 1   ${stamp(NOW - 9000)} 0:00.02 /bin/zsh -c eval 'b' < /dev/null`,
        `801 800 ${stamp(NOW - 9000)} 0:20.00 pytest -x`,
      ].join("\n")),
    }));
    const byId = new Map(snapshot.running.map((task) => [task.taskId, task.activity?.command]));
    expect(byId.get("b1")).toBe("cargo build");
    expect(byId.get("b2")).toBe("pytest -x");
  });
});
