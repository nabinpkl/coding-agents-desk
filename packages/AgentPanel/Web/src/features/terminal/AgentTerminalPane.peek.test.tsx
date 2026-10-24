// Where an echo pane's window onto its screen sits: ending at the last drawn row, re-placed when
// the box it looks through changes size after it opened. Split from the pane's main suite, which
// covers the stream, the band's height and the tap that raises the keyboard.

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { AgentTerminalPane } from "@/features/terminal/AgentTerminalPane";
import { keepLastDrawnRowInView } from "@/features/terminal/lastDrawnRowInView";

let terminal: FakeTerminal;

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  cols = 80;
  rows = 24;
  readonly options: Record<string, unknown>;
  element: HTMLElement | undefined;
  readonly buffer = { active: { type: "normal" as const, cursorY: 0, viewportY: 0, getLine: () => undefined } };
  constructor(options: Record<string, unknown>) {
    this.options = options;
    terminal = this;
  }
  open(element: HTMLElement) {
    this.element = element;
  }
  attachCustomWheelEventHandler() {}
  scrollLines() {}
  clear() {}
  reset() {}
  resize(columns: number, rows: number) {
    this.cols = columns;
    this.rows = rows;
  }
  focus() {}
  dispose() {}
  write(_bytes: Uint8Array, done: () => void) {
    done();
  }
  onData() {
    return { dispose: () => {} };
  }
  onRender() {
    return { dispose: () => {} };
  }
  onBinary() {
    return { dispose: () => {} };
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@/features/terminal/lastDrawnRowInView", () => ({ keepLastDrawnRowInView: vi.fn() }));

/** Every element observed, with the callbacks that report its resizes: the fit watches it too. */
const observed = new Map<Element, (() => void)[]>();

class FakeResizeObserver {
  constructor(private readonly report: () => void) {}
  observe(element: Element) {
    observed.set(element, [...(observed.get(element) ?? []), this.report]);
  }
  disconnect() {}
}

/** The box resizes: every observer of it hears. */
function resize(element: Element) {
  act(() => {
    for (const report of observed.get(element) ?? []) report();
  });
}

beforeEach(() => {
  observed.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(keepLastDrawnRowInView).mockClear();
});

function peekFeed() {
  return {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "erica",
      pid: 42,
      columns: 120,
      rows: 40,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource;
}

it("re-places the window when the box it looks through resizes after opening", async () => {
  const feed = peekFeed();
  render(<AgentTerminalPane feed={feed} context={{ kind: "tmux", session: "erica" }} layout="echo" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  const mount = terminal.element!;

  // The pane's height settles after it opened (a clamp to its column, or to its whole screen),
  // which changes nothing the placement was keyed on: only the box's own size says so.
  vi.mocked(keepLastDrawnRowInView).mockClear();
  resize(mount);
  expect(keepLastDrawnRowInView).toHaveBeenCalledWith(mount, expect.anything());
});

it("leaves a pane that is not a peek where it is", async () => {
  const feed = peekFeed();
  render(<AgentTerminalPane feed={feed} context={{ kind: "tmux", session: "erica" }} layout="band" />);
  await waitFor(() => expect(feed.subscribeTerminal).toHaveBeenCalled());
  resize(terminal.element!);
  expect(keepLastDrawnRowInView).not.toHaveBeenCalled();
});
