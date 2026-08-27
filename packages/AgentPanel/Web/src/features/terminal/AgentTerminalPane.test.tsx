import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentTerminalStreamMessage } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import { AgentTerminalPane } from "./AgentTerminalPane";

let terminal: FakeTerminal;

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  readonly writes: number[][] = [];
  readonly options: Record<string, unknown>;
  element: HTMLElement | undefined;
  private dataListener: ((data: string) => void) | null = null;
  private binaryListener: ((data: string) => void) | null = null;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    terminal = this;
  }

  open(element: HTMLElement) { this.element = element; }
  clear() {}
  reset() {}
  resize() {}
  focus() {}
  dispose() {}
  write(bytes: Uint8Array, done: () => void) {
    this.writes.push([...bytes]);
    done();
  }
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => { this.dataListener = null; } };
  }
  onBinary(listener: (data: string) => void) {
    this.binaryListener = listener;
    return { dispose: () => { this.binaryListener = null; } };
  }
  emitData(data: string) { this.dataListener?.(data); }
  emitBinary(data: string) { this.binaryListener?.(data); }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

it("renders the PTY stream, sends xterm input, and detaches through Agent Feed", async () => {
  let stream: ((message: AgentTerminalStreamMessage) => void) | null = null;
  const unsubscribe = vi.fn();
  const feed = {
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "agent-resume-codex-session-1",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn((_terminalId: string, handlers: {
      onMessage: (message: AgentTerminalStreamMessage) => void;
    }) => {
      stream = handlers.onMessage;
      return unsubscribe;
    }),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const onState = vi.fn();
  const context = {
    projectPath: "/projects/agent-desk",
    source: "codex" as const,
    sessionId: "session-1",
  };

  const view = render(<AgentTerminalPane feed={feed} context={context} onState={onState} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledWith(context, 80, 24));
  await waitFor(() => expect(onState).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ kind: "ready" }),
  ));

  act(() => {
    stream?.({ type: "output", revision: "1", data: "aGk=" });
    terminal.emitData("pwd\r");
    terminal.emitBinary("\xff");
  });
  await waitFor(() => expect(terminal.writes).toEqual([[104, 105]]));
  expect(feed.sendTerminalInput).toHaveBeenNthCalledWith(1, "terminal-1", "pwd\r");
  expect(feed.sendTerminalInput).toHaveBeenNthCalledWith(2, "terminal-1", "/w==", "base64");
  const separator = screen.getByRole("separator", { name: "Resize terminal" });
  expect(separator).toBeInTheDocument();
  fireEvent.keyDown(separator, { key: "ArrowUp" });
  expect(screen.getByRole("region", { name: "Codex terminal" })).toHaveStyle({ height: "150px" });

  view.unmount();
  expect(feed.closeTerminal).toHaveBeenCalledWith("terminal-1", "detach");
});

it("closes the stream without detaching a PTY that already exited", async () => {
  let stream: ((message: AgentTerminalStreamMessage) => void) | null = null;
  const unsubscribe = vi.fn();
  const feed = {
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "agent-resume-codex-session-1",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn((_terminalId: string, handlers: {
      onMessage: (message: AgentTerminalStreamMessage) => void;
    }) => {
      stream = handlers.onMessage;
      return unsubscribe;
    }),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const onState = vi.fn();
  const context = {
    projectPath: "/projects/agent-desk",
    source: "codex" as const,
    sessionId: "session-1",
  };

  const view = render(<AgentTerminalPane feed={feed} context={context} onState={onState} />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  act(() => stream?.({ type: "exited", status: 0 }));

  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(onState).toHaveBeenLastCalledWith(context, { kind: "ended", exitStatus: 0 });
  view.unmount();
  expect(feed.closeTerminal).not.toHaveBeenCalled();
});
