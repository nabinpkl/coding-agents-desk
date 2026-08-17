import { describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { assembleSnapshot, type SnapshotSources } from "./backgroundTasks.ts";
import type { TaskIdentity } from "./taskIdentity.ts";
import type { TaskNotification } from "./taskState.ts";

const NOW = Date.UTC(2026, 7, 14, 18, 0, 0);
const ROOT = config.claudeTaskRoot;

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
    shellDetails: new Map(),
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
      shellDetails: new Map([[100, { pid: 100, startedAt: NOW - 200, command: "curl -s https://x" }]]),
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
      shellDetails: new Map([
        [100, { pid: 100, startedAt: NOW - 360_000, command: "python3 run.py --model flash" }],
      ]),
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
      shellDetails: new Map([[100, { pid: 100, startedAt: NOW - 200, command: "grep -r x ." }]]),
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
