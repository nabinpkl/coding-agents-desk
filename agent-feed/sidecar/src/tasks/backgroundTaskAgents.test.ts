import { describe, expect, test } from "bun:test";
import { assembleSnapshot, type SnapshotSources } from "@/tasks/backgroundTasks";
import type { AgentIdentity, TaskIdentity } from "@/tasks/taskIdentity";
import type { TaskNotification } from "@/tasks/taskState";

// Split from `backgroundTasks.test.ts` when the two together passed the 500-line cap. Subagents
// are the one task kind with no shell, no capture file and no process row, so their fixtures need
// almost none of what the other kinds' tests set up, and the default below is built for them
// rather than shared with a case it does not fit.

const NOW = Date.UTC(2026, 7, 14, 18, 0, 0);

function sources(overrides: Partial<SnapshotSources> = {}): SnapshotSources {
  return {
    shells: [],
    identities: new Map(),
    notifications: new Map(),
    markers: new Map(),
    captureSizes: new Map(),
    processes: [],
    monitors: new Map(),
    agents: new Map(),
    ownerPid: 1,
    uncorroboratedAfterMs: 5000,
    ownerAlive: true,
    ownerWaiting: false,
    now: NOW,
    ...overrides,
  };
}

describe("assembleSnapshot, subagents", () => {
  function agent(agentId: string, overrides: Partial<AgentIdentity> = {}): AgentIdentity {
    return {
      agentId,
      description: "Investigate transcript stream staleness",
      subagentType: "fork",
      model: "opus",
      resolvedModel: "claude-opus-5[1m]",
      startedAt: NOW - 90_000,
      launchedAsync: true,
      ...overrides,
    };
  }

  const completed = (taskId: string): TaskNotification => ({
    kind: "completion",
    taskId,
    status: "completed",
    summary: "Agent finished",
    exitCode: null,
    taskKind: "agent",
  });

  test("a launched subagent is running, with no shell and no process to prove it", () => {
    const snapshot = assembleSnapshot(sources({
      agents: new Map([["a6da370b", agent("a6da370b")]]),
    }));
    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]).toMatchObject({
      taskId: "a6da370b",
      kind: "agent",
      description: "Investigate transcript stream staleness",
      elapsedMs: 90_000,
      corroborated: true,
      // Both of these are claims about a subagent having no process, not gaps in the reading.
      activity: null,
      hasOutput: false,
      agent: {
        subagentType: "fork",
        model: "opus",
        resolvedModel: "claude-opus-5[1m]",
        launchedAsync: true,
      },
    });
  });

  test("its completion retires it, which is the whole reason the second shape had to be read", () => {
    const snapshot = assembleSnapshot(sources({
      agents: new Map([["a6da370b", agent("a6da370b")]]),
      notifications: new Map([["a6da370b", completed("a6da370b")]]),
    }));
    expect(snapshot.running).toEqual([]);
    expect(snapshot.finished).toHaveLength(1);
    expect(snapshot.finished[0]).toMatchObject({
      taskId: "a6da370b",
      kind: "agent",
      // Its own words, not the notification's summary.
      description: "Investigate transcript stream staleness",
      agent: { subagentType: "fork" },
    });
  });

  test("a synchronous subagent is never shown running, because it cannot be observed running", () => {
    const snapshot = assembleSnapshot(sources({
      agents: new Map([["sync-1", agent("sync-1", { launchedAsync: false })]]),
    }));
    expect(snapshot.running).toEqual([]);
    expect(snapshot.finished).toHaveLength(1);
    expect(snapshot.finished[0]).toMatchObject({ taskId: "sync-1", kind: "agent" });
  });

  test("a launch record outranks a notification's tags when deciding what a run was", () => {
    // The notification aged out of the window and a bash-shaped one arrived in its place. The
    // launch is the stronger evidence, so the row stays an agent rather than being demoted.
    const snapshot = assembleSnapshot(sources({
      agents: new Map([["a1", agent("a1")]]),
      notifications: new Map<string, TaskNotification>([
        ["a1", { kind: "completion", taskId: "a1", status: "completed", summary: "done", exitCode: 0, taskKind: "bash" }],
      ]),
    }));
    expect(snapshot.finished[0]).toMatchObject({ taskId: "a1", kind: "agent" });
  });

  test("subagents do not disturb the shells and watchers beside them", () => {
    const snapshot = assembleSnapshot(sources({
      agents: new Map([["a1", agent("a1")]]),
      identities: new Map<string, TaskIdentity>([["bshell1", {
        taskId: "bshell1",
        description: "run bshell1",
        command: "echo bshell1",
        startedAt: NOW - 60_000,
        capturePath: "/tmp/tasks/bshell1.output",
      }]]),
      notifications: new Map<string, TaskNotification>([
        ["bshell1", { kind: "completion", taskId: "bshell1", status: "completed", summary: "ok (exit code 0)", exitCode: 0, taskKind: "bash" }],
      ]),
    }));
    expect(snapshot.running.map((task) => task.kind)).toEqual(["agent"]);
    expect(snapshot.finished.map((task) => task.kind)).toEqual(["bash"]);
  });
});
