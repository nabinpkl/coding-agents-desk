import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentTerminalStreamMessage } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { AgentTerminalPane, paneShapeForLayout } from "@/features/terminal/AgentTerminalPane";

let terminal: FakeTerminal;

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  // The grid, which a band pane takes its opening height from.
  cols = 80;
  rows = 24;
  readonly writes: number[][] = [];
  readonly options: Record<string, unknown>;
  element: HTMLElement | undefined;
  private dataListener: ((data: string) => void) | null = null;
  private binaryListener: ((data: string) => void) | null = null;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    terminal = this;
  }

  focuses = 0;
  readonly buffer = { active: { type: "normal" as const, cursorY: 0, viewportY: 0, getLine: () => undefined } };
  textarea: HTMLTextAreaElement | undefined;
  open(element: HTMLElement) {
    this.element = element;
    // xterm's hidden helper field, which is what actually holds focus and what the pane listens to
    // for whether this terminal is the thing being typed into.
    this.textarea = element.ownerDocument.createElement("textarea");
    element.append(this.textarea);
  }
  attachCustomWheelEventHandler() {}
  scrollLines() {}
  clear() {}
  reset() {}
  resize(columns: number, rows: number) { this.cols = columns; this.rows = rows; }
  focus() { this.focuses++; this.textarea?.focus(); }
  dispose() {}
  write(bytes: Uint8Array, done: () => void) {
    this.writes.push([...bytes]);
    done();
  }
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => { this.dataListener = null; } };
  }
  // Nothing renders in jsdom; the pane's watch on the last drawn row only needs the hook.
  onRender() { return { dispose: () => {} }; }
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
    terminalHistory: vi.fn(async () => ""),
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
    kind: "agent-session" as const,
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
    terminalHistory: vi.fn(async () => ""),
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
    kind: "agent-session" as const,
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

it("sizes a band pane from its own height, with the viewport as its ceiling", async () => {
  const feed = {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "composerprobe",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const context = { kind: "tmux" as const, session: "composerprobe" };
  vi.stubGlobal("innerHeight", 1000);

  render(<AgentTerminalPane feed={feed} context={context} onState={vi.fn()} layout="band" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  const pane = screen.getByRole("region", { name: "composerprobe terminal" });
  // A height of its own from the start: the band reserves no box around it, so a pane sized as a
  // share of its parent would collapse to the minimum instead.
  //
  // The share is the fallback, and it is what jsdom sees: the height a pane really wants is the one
  // that spends the width its screen has, and jsdom measures every box at zero, so there is no
  // width to spend. That arithmetic is pinned in `terminalTypeFit.test.ts` instead.
  expect(pane).toHaveStyle({ height: "420px" });

  // The ceiling comes from the viewport, because the parent measures the pane itself.
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize terminal" }), { key: "End" });
  expect(pane).toHaveStyle({ height: "720px" });
});

it("opens at the height it was left at, and reports every height it is dragged to", async () => {
  // The peek is the case this exists for. An echo opens at the minimum on purpose, so a reader who
  // dragged one taller and came back to the minimum would have to drag it again every visit.
  const feed = {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "composerprobe",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const context = { kind: "tmux" as const, session: "composerprobe" };
  vi.stubGlobal("innerHeight", 1000);
  const onResized = vi.fn();

  render(
    <AgentTerminalPane
      feed={feed}
      context={context}
      onState={vi.fn()}
      layout="echo"
      rememberedHeight={317}
      onResized={onResized}
    />,
  );
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  const pane = screen.getByRole("region", { name: "composerprobe terminal" });
  expect(pane).toHaveStyle({ height: "317px" });
  // Nothing was dragged yet, so nothing has been said about a height.
  expect(onResized).not.toHaveBeenCalled();

  // What is reported is what the pane took, not what the key asked for. The two can differ -- a
  // drag past the ceiling is clamped -- and a next visit that opened at a height the pane would
  // refuse would come back somewhere the reader never left it.
  //
  // Home and End rather than the arrows, because the arrows step from the pane's MEASURED height
  // and jsdom measures every box at zero; the arithmetic they use is the same.
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize terminal" }), { key: "End" });
  expect(onResized).toHaveBeenLastCalledWith(720);
  expect(pane).toHaveStyle({ height: "720px" });

  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize terminal" }), { key: "Home" });
  expect(onResized).toHaveBeenLastCalledWith(150);
  expect(pane).toHaveStyle({ height: "150px" });
});

it("never lets a band reshape the session, whichever band it is", () => {
  // The rule every band inherits, rather than a prop each call site remembers: a tmux window has
  // one size for everyone, and a band that claimed shrank the live session to its own strip.
  // Asserted here rather than through a rendered pane because a viewport report needs a measured
  // box, and jsdom measures every box at zero.
  expect(paneShapeForLayout("band")).toBe("follow");
  // An echo harder than a band: it is the shortest pane there is, so a claim from one would pin
  // the session smaller than the strip that made this rule in the first place.
  expect(paneShapeForLayout("echo")).toBe("follow");
  expect(paneShapeForLayout("column")).toBe("adopt");
  // A surface that is neither can still say so, and saying so wins.
  expect(paneShapeForLayout("band", "adopt")).toBe("adopt");
  expect(paneShapeForLayout("column", "follow")).toBe("follow");
});

it("zooms the type per pane, without re-attaching to the session", async () => {
  const feed = {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "composerprobe",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const context = { kind: "tmux" as const, session: "composerprobe" };

  render(<AgentTerminalPane feed={feed} context={context} onState={vi.fn()} layout="band" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());

  // Sized to the pane until somebody says otherwise, so there is nothing to reset to yet.
  const reset = screen.getByRole("button", { name: "Type is sized to the pane" });
  expect(reset).toBeDisabled();

  // Relative rather than absolute: jsdom measures every box at zero, so the pane never resolves a
  // size of its own to step away from. What matters is that a press moves the type by a step and
  // that the label says which size is in force -- the arithmetic itself is
  // `terminalTypeFit.test.ts`.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Larger type" }));
  });
  const first = terminal.options.fontSize as number;
  expect(screen.getByRole("button", { name: "Size the type to the pane" }))
    .toHaveTextContent(`${first}pt`);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Larger type" }));
  });
  expect(terminal.options.fontSize).toBe(first + 1);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Smaller type" }));
  });
  expect(terminal.options.fontSize).toBe(first);

  // The whole point of holding the choice in a ref: a press must not be a reason to dispose the
  // terminal, re-open the pane and import its scrollback again.
  expect(feed.openTerminal).toHaveBeenCalledTimes(1);
  expect(feed.terminalHistory).toHaveBeenCalledTimes(1);

  // And handing it back leaves the pane sizing itself again.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Size the type to the pane" }));
  });
  expect(screen.getByRole("button", { name: "Type is sized to the pane" })).toBeDisabled();
});

/** A touch event jsdom will carry: only the two lists the tap handler reads have to be real. */
function touch(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  const point = { clientX: x, clientY: y };
  Object.assign(event, { touches: [point], changedTouches: [point] });
  return event;
}

it("focuses on a tap, which is the only thing that raises a phone's keyboard", async () => {
  const feed = {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "composerprobe",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const context = { kind: "tmux" as const, session: "composerprobe" };

  render(<AgentTerminalPane feed={feed} context={context} onState={vi.fn()} />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  const mount = terminal.element!;
  // xterm focuses from `mousedown`, and its touch Gesture preventDefaults the touch that would
  // have synthesized one -- so without this the terminal is never focused by a finger.
  const opened = terminal.focuses;

  act(() => {
    mount.dispatchEvent(touch("touchstart", 100, 100));
    mount.dispatchEvent(touch("touchend", 102, 103));
  });
  expect(terminal.focuses).toBe(opened + 1);

  // A finger that travelled was reading, not asking to type.
  act(() => {
    mount.dispatchEvent(touch("touchstart", 100, 100));
    mount.dispatchEvent(touch("touchend", 100, 180));
  });
  expect(terminal.focuses).toBe(opened + 1);
});

it("gives the band pane back its height when the keyboard closes", async () => {
  const feed = {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "composerprobe",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
  const context = { kind: "tmux" as const, session: "composerprobe" };
  vi.stubGlobal("innerHeight", 1000);

  render(<AgentTerminalPane feed={feed} context={context} onState={vi.fn()} layout="band" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  const pane = screen.getByRole("region", { name: "composerprobe terminal" });
  expect(pane).toHaveStyle({ height: "420px" });

  // A keyboard takes 600px of the screen. The shell shortens to fit above it, so the pane has to
  // fit inside what is left rather than crushing the transcript it sits under.
  vi.stubGlobal("innerHeight", 400);
  act(() => {
    globalThis.dispatchEvent(new Event("resize"));
  });
  expect(pane).toHaveStyle({ height: "288px" });

  // The height it asked for is remembered, not overwritten, so dismissing the keyboard restores it.
  vi.stubGlobal("innerHeight", 1000);
  act(() => {
    globalThis.dispatchEvent(new Event("resize"));
  });
  expect(pane).toHaveStyle({ height: "420px" });
});

function railFeed() {
  return {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "composerprobe",
      pid: 42,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
}

/** A phone: no hover, coarse pointer, and a keyboard that appears over half the screen. */
function stubTouchSurface(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

it("gives a phone the keys its keyboard does not have, once the terminal has focus", async () => {
  stubTouchSurface(true);
  const feed = railFeed();
  const context = { kind: "tmux" as const, session: "composerprobe" };
  render(<AgentTerminalPane feed={feed} context={context} onState={vi.fn()} layout="band" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());

  // Opening focuses the terminal, so the rail is there with the keyboard it belongs to.
  expect(screen.getByLabelText("Terminal key rail")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Esc" }));
  expect(feed.sendTerminalInput).toHaveBeenLastCalledWith("terminal-1", "\u001b");
  fireEvent.click(screen.getByRole("button", { name: "↑" }));
  expect(feed.sendTerminalInput).toHaveBeenLastCalledWith("terminal-1", "\u001b[A");

  // The rail supplies the Ctrl and the phone's own keyboard supplies the letter: only the hook
  // sees both, which is why the latch lives there rather than in the rail.
  fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
  act(() => terminal.emitData("c"));
  expect(feed.sendTerminalInput).toHaveBeenLastCalledWith("terminal-1", "\u0003");

  // Armed rather than locked: one key spends it, and the next letter is a letter again.
  act(() => terminal.emitData("c"));
  expect(feed.sendTerminalInput).toHaveBeenLastCalledWith("terminal-1", "c");

  act(() => terminal.textarea?.dispatchEvent(new FocusEvent("blur")));
  expect(screen.queryByLabelText("Terminal key rail")).toBeNull();
});

it("leaves the rail off a browser whose keyboard already has those keys", async () => {
  stubTouchSurface(false);
  const feed = railFeed();
  const context = { kind: "tmux" as const, session: "composerprobe" };
  render(<AgentTerminalPane feed={feed} context={context} onState={vi.fn()} layout="band" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());

  act(() => terminal.textarea?.dispatchEvent(new FocusEvent("focus")));
  expect(screen.queryByLabelText("Terminal key rail")).toBeNull();
});
