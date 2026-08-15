import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type {
  BackgroundTaskSnapshot,
  RunningBackgroundTask,
  TaskOutputMessage,
} from "@agentdesk/agent-feed-wire";
import { stubDataSource } from "../activity-feed/data-source/stubDataSource";
import type { SessionReference } from "../activity-feed/data-source/AgentDataSource";
import { BackgroundTasksContent } from "./BackgroundTasksPanel";
import { RunningTasksChip } from "./RunningTasksChip";

const SESSION: SessionReference = { source: "claude", sessionId: "s1", mode: "nice" };

function running(overrides: Partial<RunningBackgroundTask> = {}): RunningBackgroundTask {
  return {
    taskId: "b1",
    kind: "bash",
    description: "Run the full test suite",
    command: "just check",
    startedAt: Date.now() - 65_000,
    state: { status: "running" },
    elapsedMs: 65_000,
    hasOutput: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BackgroundTaskSnapshot> = {}): BackgroundTaskSnapshot {
  return { running: [], finished: [], ownerAlive: true, ...overrides };
}

describe("RunningTasksChip", () => {
  it("renders nothing when nothing is running", () => {
    // An idle session should not pay a band, and a chip that always says "0" trains people to
    // stop seeing it.
    const { container } = render(<RunningTasksChip count={0} open={false} onToggle={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts in the singular and the plural", () => {
    const { rerender } = render(<RunningTasksChip count={1} open={false} onToggle={() => {}} />);
    expect(screen.getByTestId("running-tasks-chip")).toHaveTextContent("1 running task");
    rerender(<RunningTasksChip count={3} open={false} onToggle={() => {}} />);
    expect(screen.getByTestId("running-tasks-chip")).toHaveTextContent("3 running tasks");
  });

  it("toggles the panel", () => {
    const onToggle = vi.fn();
    render(<RunningTasksChip count={2} open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId("running-tasks-chip"));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("BackgroundTasksContent", () => {
  it("shows a running task with its elapsed time", () => {
    render(
      <BackgroundTasksContent
        snapshot={snapshot({ running: [running()] })}
        source={stubDataSource()}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Run the full test suite")).toBeInTheDocument();
    expect(screen.getByText(/1m 5s/)).toBeInTheDocument();
  });

  it("says so when a task's output was redirected away from its capture", () => {
    // This is the case other tools render as "No output yet"; naming it is how the viewer knows
    // the empty capture is expected rather than broken.
    render(
      <BackgroundTasksContent
        snapshot={snapshot({ running: [running({ hasOutput: false })] })}
        source={stubDataSource()}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/output redirected/)).toBeInTheDocument();
  });

  it("opens no output stream until a row is expanded, and closes it on collapse", () => {
    // The cost model: N tasks in flight must not become N open streams to a phone.
    const unsubscribe = vi.fn();
    let openedFor: string | null = null;
    const subscribeTaskOutput = vi.fn((_session: SessionReference, taskId: string) => {
      openedFor = taskId;
      return unsubscribe;
    });
    render(
      <BackgroundTasksContent
        snapshot={snapshot({ running: [running()] })}
        source={stubDataSource({ subscribeTaskOutput })}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    expect(subscribeTaskOutput).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("task-row-b1"));
    expect(subscribeTaskOutput).toHaveBeenCalledTimes(1);
    expect(openedFor).toBe("b1");

    fireEvent.click(screen.getByTestId("task-row-b1"));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("streams appended output into the expanded row", () => {
    let emit: ((message: TaskOutputMessage) => void) | undefined;
    const subscribeTaskOutput = vi.fn((_session, _taskId, handlers) => {
      emit = handlers.onMessage;
      return () => {};
    });
    render(
      <BackgroundTasksContent
        snapshot={snapshot({ running: [running()] })}
        source={stubDataSource({ subscribeTaskOutput })}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("task-row-b1"));

    act(() => {
      emit?.({
        kind: "snapshot",
        label: "build.log",
        text: "[1] starting\n",
        offset: 13,
        progress: { bytes: 13, bytesPerSecond: 0, idleMs: 0 },
      });
    });
    expect(screen.getByTestId("task-output")).toHaveTextContent("[1] starting");
    expect(screen.getByText("build.log")).toBeInTheDocument();

    act(() => {
      emit?.({
        kind: "append",
        text: "[2] compiling\n",
        offset: 27,
        progress: { bytes: 27, bytesPerSecond: 24.2, idleMs: 0 },
      });
    });
    const output = screen.getByTestId("task-output");
    expect(output).toHaveTextContent("[1] starting");
    expect(output).toHaveTextContent("[2] compiling");
    // The progress pair, reported and not classified. No "stuck" verdict anywhere.
    expect(screen.getByText(/24 B\/s/)).toBeInTheDocument();
  });

  it("reports idle time so a wedged task is distinguishable from a finished one", () => {
    let emit: ((message: TaskOutputMessage) => void) | undefined;
    render(
      <BackgroundTasksContent
        snapshot={snapshot({ running: [running()] })}
        source={stubDataSource({
          subscribeTaskOutput: (_session, _taskId, handlers) => {
            emit = handlers.onMessage;
            return () => {};
          },
        })}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("task-row-b1"));
    act(() => {
      emit?.({
        kind: "snapshot",
        label: "build.log",
        text: "",
        offset: 0,
        progress: { bytes: 0, bytesPerSecond: 0, idleMs: 0 },
      });
      emit?.({
        kind: "append",
        text: "",
        offset: 0,
        progress: { bytes: 0, bytesPerSecond: 0, idleMs: 45_000 },
      });
    });
    expect(screen.getByText(/idle 45s/)).toBeInTheDocument();
  });

  it("distinguishes a dead owner from an idle one", () => {
    render(
      <BackgroundTasksContent
        snapshot={snapshot({ ownerAlive: false })}
        source={stubDataSource()}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/No live process is serving this session/)).toBeInTheDocument();
  });

  it("keeps finished tasks collapsed, and names a kill as a kill", () => {
    render(
      <BackgroundTasksContent
        snapshot={snapshot({
          finished: [
            {
              taskId: "b9",
              kind: "bash",
              description: "Rebuild the host",
              command: null,
              startedAt: Date.now() - 600_000,
              state: { status: "killed" },
            },
          ],
        })}
        source={stubDataSource()}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("Rebuild the host")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("finished-tasks-toggle"));
    expect(screen.getByText("Rebuild the host")).toBeInTheDocument();
    expect(screen.getByText("killed")).toBeInTheDocument();
  });

  it("does not render a failed exit as a success", () => {
    // exitCode null means "over, code not recorded". Flattening it to 0 would read as success.
    render(
      <BackgroundTasksContent
        snapshot={snapshot({
          finished: [{
            taskId: "b9",
            kind: "bash",
            description: "Gate",
            command: null,
            startedAt: 1,
            state: { status: "exited", exitCode: null },
          }],
        })}
        source={stubDataSource()}
        session={SESSION}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("finished-tasks-toggle"));
    expect(screen.getByText("failed")).toBeInTheDocument();
  });
});
