import { describe, expect, test } from "bun:test";
import {
  parseBackgroundStart,
  parseTaskNotification,
  parseTerminalMarker,
  resolveTaskState,
} from "./taskState.ts";

describe("parseTerminalMarker", () => {
  test("reads a clean exit", () => {
    expect(parseTerminalMarker("experiment done\n\n[exited with code 0]")).toEqual({
      status: "exited",
      exitCode: 0,
    });
  });

  test("reads a non-zero exit", () => {
    expect(parseTerminalMarker("boom\n\n[exited with code 143]")).toEqual({
      status: "exited",
      exitCode: 143,
    });
  });

  test("reads a kill, which is the outcome the transcript never records", () => {
    expect(parseTerminalMarker("\n[killed]\n")).toEqual({ status: "killed" });
  });

  test("an empty capture is still running, not a silent success", () => {
    expect(parseTerminalMarker("")).toBeNull();
  });

  test("output that mentions a marker mid-stream does not close the task", () => {
    // A build log narrating some other process is not this task's fate. Anchoring to the end is
    // the whole defence, and a substring search would have retired a task that is still running.
    const tail = "[killed] the stale server\n[exited with code 0] was printed by the script\nstill going\n";
    expect(parseTerminalMarker(tail)).toBeNull();
  });
});

describe("parseBackgroundStart", () => {
  test("takes the harness's own output path rather than rebuilding one", () => {
    const text = "Command running in background with ID: bu2wb68vl. Output is being written to: " +
      "/private/tmp/claude-501/-Users-dev/2adc3708/tasks/bu2wb68vl.output. You will be notified.";
    expect(parseBackgroundStart(text)).toEqual({
      taskId: "bu2wb68vl",
      capturePath: "/private/tmp/claude-501/-Users-dev/2adc3708/tasks/bu2wb68vl.output",
    });
  });

  test("ordinary tool output is not a start record", () => {
    expect(parseBackgroundStart("BUILD SUCCEEDED")).toBeNull();
  });
});

describe("parseTaskNotification", () => {
  const completion = `<task-notification>
<task-id>bu2wb68vl</task-id>
<tool-use-id>toolu_01Cdq6cFhcuhbUe7JBC8QW6K</tool-use-id>
<output-file>/private/tmp/claude-501/x/y/tasks/bu2wb68vl.output</output-file>
<status>completed</status>
<summary>Background command "Long-running probe task" completed (exit code 0)</summary>
</task-notification>`;

  test("reads a shell completion and its exit code", () => {
    expect(parseTaskNotification(completion)).toEqual({
      kind: "completion",
      taskId: "bu2wb68vl",
      status: "completed",
      summary: 'Background command "Long-running probe task" completed (exit code 0)',
      exitCode: 0,
      taskKind: "bash",
    });
  });

  test("a failure keeps its code instead of flattening to success", () => {
    const failed = completion
      .replace("<status>completed</status>", "<status>failed</status>")
      .replace("completed (exit code 0)", "failed (exit code 1)");
    const parsed = parseTaskNotification(failed);
    expect(parsed).toMatchObject({ kind: "completion", status: "failed", exitCode: 1 });
  });

  test("a summary naming no code reports null, not zero", () => {
    const vague = completion.replace("completed (exit code 0)", "completed");
    expect(parseTaskNotification(vague)).toMatchObject({ exitCode: null });
  });

  test("a subagent completion is told apart by its usage tags", () => {
    const subagent = `<task-notification>
<task-id>a9269583b896da4dd</task-id>
<status>completed</status>
<summary>Agent "reviewer" completed</summary>
<subagent_tokens>41234</subagent_tokens>
<tool_uses>12</tool_uses>
</task-notification>`;
    expect(parseTaskNotification(subagent)).toMatchObject({ taskKind: "agent" });
  });

  test("a Monitor tick is progress, not a completion", () => {
    // The trap: Monitor fires repeatedly over its life and carries no <status>. Reading any of
    // these as a completion retires a watcher that is still watching.
    const tick = `<task-notification>
<task-id>b3xj3ww32</task-id>
<summary>Monitor event: "device relaunch"</summary>
<event>error: Recipe was terminated by signal 15</event>
</task-notification>`;
    expect(parseTaskNotification(tick)).toEqual({
      kind: "progress",
      taskId: "b3xj3ww32",
      summary: 'Monitor event: "device relaunch"',
    });
  });

  test("a summary running across lines survives", () => {
    const multiline = completion.replace(
      "completed (exit code 0)",
      "completed\nwith a summary that wrapped (exit code 0)",
    );
    expect(parseTaskNotification(multiline)).toMatchObject({ exitCode: 0 });
  });

  test("ordinary prose is not a notification", () => {
    expect(parseTaskNotification("the build finished")).toBeNull();
  });
});

describe("resolveTaskState", () => {
  const none = { holdsOutputOpen: false, marker: null, notification: null };

  test("a held output descriptor outranks a transcript that says otherwise", () => {
    expect(resolveTaskState({ ...none, holdsOutputOpen: true })).toEqual({ status: "running" });
  });

  test("a kill marker wins over a transcript that never heard about it", () => {
    // The measured case: two of one session's four finished tasks were killed, and the
    // transcript still described them as running. Permanently.
    expect(resolveTaskState({ ...none, marker: { status: "killed" } })).toEqual({ status: "killed" });
  });

  test("a completion notification resolves a task whose output file was reaped", () => {
    expect(resolveTaskState({
      ...none,
      notification: {
        kind: "completion",
        taskId: "b1",
        status: "completed",
        summary: "",
        exitCode: 0,
        taskKind: "bash",
      },
    })).toEqual({ status: "exited", exitCode: 0 });
  });

  test("a progress tick never resolves anything", () => {
    expect(resolveTaskState({
      ...none,
      notification: { kind: "progress", taskId: "b1", summary: "" },
    })).toEqual({ status: "unknown" });
  });

  test("no evidence is unknown, never running", () => {
    // A start with nothing behind it is a reaped task from a dead session. Calling it running
    // would inflate the chip's count forever, which is the failure transcript-only detection has.
    expect(resolveTaskState(none)).toEqual({ status: "unknown" });
  });
});
