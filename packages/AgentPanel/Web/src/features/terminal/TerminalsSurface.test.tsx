import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import { TerminalsSurface } from "./TerminalsSurface";

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  readonly options: Record<string, unknown>;
  element: HTMLElement | undefined;
  constructor(options: Record<string, unknown>) { this.options = options; }
  open(element: HTMLElement) { this.element = element; }
  clear() {}
  reset() {}
  resize() {}
  focus() {}
  dispose() {}
  write(_bytes: Uint8Array, done: () => void) { done(); }
  onData() { return { dispose: () => {} }; }
  onBinary() { return { dispose: () => {} }; }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));


function feedWith(sessions: unknown[], overrides: Partial<SidecarDataSource> = {}) {
  return {
    listTmuxSessions: vi.fn(async () => sessions),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "agent-tmux-one",
      pid: 7,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    sendTerminalInput: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
    ...overrides,
  } as unknown as SidecarDataSource;
}

it("opens one terminal per tmux session, each at its own fixed grid", async () => {
  const feed = feedWith([
    { name: "canvas-fork", windows: 1, attachedClients: 0, path: "/projects/agent-desk" },
    { name: "keyboard", windows: 2, attachedClients: 1, path: "/projects/agent-desk" },
  ]);

  render(<TerminalsSurface feed={feed} />);

  expect(await screen.findByLabelText("canvas-fork terminal")).toBeTruthy();
  expect(screen.getByLabelText("keyboard terminal")).toBeTruthy();
  expect(screen.getByText("2 tmux sessions")).toBeTruthy();
  // Not measured from the tile: a tile that fitted itself would push its size onto the PTY, and
  // through it onto whatever terminal has the same tmux session open.
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledTimes(2));
  expect(vi.mocked(feed.openTerminal).mock.calls).toEqual([
    [{ kind: "tmux", session: "canvas-fork" }, 80, 24],
    [{ kind: "tmux", session: "keyboard" }, 80, 24],
  ]);
});

it("ends the attach on close, rather than leaving a client holding the window", async () => {
  const feed = feedWith([
    { name: "canvas-fork", windows: 1, attachedClients: 0, path: "/projects/agent-desk" },
  ]);
  const view = render(<TerminalsSurface feed={feed} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  view.unmount();

  // Not "detach": the PTY session outliving its viewer is what keeps a resumed CLI warm, and for
  // an attach it means a tmux client nobody is watching goes on holding the window at 80x24.
  await waitFor(() => expect(feed.closeTerminal).toHaveBeenCalledWith("terminal-1", "kill"));
});

it("says the machine is empty rather than showing an empty wall", async () => {
  render(<TerminalsSurface feed={feedWith([])} />);
  expect(await screen.findByText(/No tmux sessions/)).toBeTruthy();
});

it("surfaces the sidecar's reason when tmux cannot be reached", async () => {
  const feed = feedWith([], {
    listTmuxSessions: vi.fn(async () => { throw new Error("no tmux binary found"); }),
  } as unknown as Partial<SidecarDataSource>);
  render(<TerminalsSurface feed={feed} />);
  expect(await screen.findByText("no tmux binary found")).toBeTruthy();
});
