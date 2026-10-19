// The key rail a phone gets on its keyboard for a focused terminal, for the keys that keyboard lacks,
// and its absence on a browser whose keyboard has them. Through the real keyboard watcher and bar,
// because the rail is drawn nowhere else. Split from the pane's main suite, which covers the stream,
// the band's height and the tap that raises the keyboard.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installKeyboardInset } from "@/app/page/keyboardInset";
import { KeyboardBar } from "@/features/keyboard/KeyboardBar";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";

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
  resize(columns: number, rows: number) {
    this.cols = columns;
    this.rows = rows;
  }
  focus() {
    this.focuses++;
    this.textarea?.focus();
  }
  dispose() {}
  write(bytes: Uint8Array, done: () => void) {
    this.writes.push([...bytes]);
    done();
  }
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataListener = null;
      },
    };
  }
  // Nothing renders in jsdom; the pane's watch on the last drawn row only needs the hook.
  onRender() {
    return { dispose: () => {} };
  }
  onBinary(listener: (data: string) => void) {
    this.binaryListener = listener;
    return {
      dispose: () => {
        this.binaryListener = null;
      },
    };
  }
  emitData(data: string) {
    this.dataListener?.(data);
  }
  emitBinary(data: string) {
    this.binaryListener?.(data);
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

let keyboard: { remove(): void } | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  act(() => keyboard?.remove());
  keyboard = null;
  vi.unstubAllGlobals();
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

/**
 * A phone, or not: whether the pointer is coarse, and a visual viewport its keyboard shrinks. The
 * keyboard is raised already, since the pane focuses its terminal as it opens.
 */
function stubTouchSurface(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal(
    "visualViewport",
    Object.assign(new EventTarget(), { height: 508, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 }),
  );
  keyboard = installKeyboardInset();
}

function renderPane(feed: SidecarDataSource) {
  const context = { kind: "tmux" as const, session: "composerprobe" };
  render(
    <>
      <KeyboardBar />
      <AgentTerminalPane feed={feed} context={context} onState={vi.fn()} layout="band" />
    </>,
  );
}

it("gives a phone the keys its keyboard does not have, on the keyboard, once the terminal has focus", async () => {
  stubTouchSurface(true);
  const feed = railFeed();
  renderPane(feed);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());

  // Opening focuses the terminal, so the rail is there with the keyboard it belongs to, standing
  // on the keyboard bar in place of the bar's own keys.
  const bar = screen.getByRole("toolbar", { name: "Keyboard keys" });
  expect(bar.contains(screen.getByLabelText("Terminal key rail"))).toBe(true);
  expect(screen.getAllByRole("button", { name: "Esc" })).toHaveLength(1);

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

  act(() => terminal.textarea?.blur());
  expect(screen.queryByLabelText("Terminal key rail")).toBeNull();
});

it("leaves the rail off a browser whose keyboard already has those keys", async () => {
  stubTouchSurface(false);
  const feed = railFeed();
  renderPane(feed);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());

  act(() => terminal.textarea?.focus());
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(screen.queryByLabelText("Terminal key rail")).toBeNull();
});
