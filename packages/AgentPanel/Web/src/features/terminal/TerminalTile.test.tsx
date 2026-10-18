import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalTile } from "@/features/terminal/TerminalTile";
import { loadTileBox } from "@/features/terminal/terminalTileSize";

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  cols = 80;
  rows = 24;
  readonly buffer = { active: { cursorY: 0, viewportY: 0, getLine: () => undefined } };
  // Just enough chrome for the fit to read and write: the real terminal carries far more.
  options: { fontSize: number | null } = { fontSize: 13 };
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;

  constructor() {}
  open(element: HTMLElement) {
    this.element = element;
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
  focus() {}
  dispose() {}
  write(_data: unknown, done?: () => void) {
    done?.();
  }
  onData() {
    return { dispose: () => {} };
  }
  // Nothing renders in jsdom; the pane's watch on the last drawn row only needs the hook.
  onRender() {
    return { dispose: () => {} };
  }
  onBinary() {
    return { dispose: () => {} };
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));

function feedDouble() {
  return {
    terminalHistory: vi.fn(async () => ""),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "tile-1",
      pid: 42,
      columns: 100,
      rows: 30,
    })),
    subscribeTerminal: vi.fn(() => vi.fn()),
    sendTerminalInput: vi.fn(async () => {}),
    updateTerminalViewport: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  } as unknown as SidecarDataSource & {
    openTerminal: ReturnType<typeof vi.fn>;
    updateTerminalViewport: ReturnType<typeof vi.fn>;
  };
}

function tileBoxOf(container: HTMLElement): { width: number; height: number } | null {
  const mount = container.querySelector("section > div") as HTMLElement | null;
  const width = Number.parseFloat(mount?.style.width ?? "");
  const height = Number.parseFloat(mount?.style.height ?? "");
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

it("opens at the remembered grid and grows its own box from the handle", async () => {
  const feed = feedDouble();
  localStorage.setItem("agent-panel.terminal.tile-grid", JSON.stringify({ ":tile-1": { columns: 100, rows: 30 } }));
  localStorage.setItem("agent-panel.terminal.tile-box", JSON.stringify({ ":tile-1": { width: 400, height: 300 } }));
  const view = render(
    <TerminalTile feed={feed} session={{ name: "tile-1" }} storageKey=":tile-1" onAttachImage={() => {}} />,
  );
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledWith({ kind: "tmux", session: "tile-1" }, 100, 30));

  // The keyboard path: one press right widens the box by one cell and remembers it --
  // locally. The wall follows the pane and never claims its shape.
  fireEvent.keyDown(screen.getByRole("button", { name: "Resize tile-1 terminal" }), { key: "ArrowRight" });
  expect(tileBoxOf(view.container)).toEqual({ width: 408, height: 300 });
  expect(loadTileBox(":tile-1")).toEqual({ width: 408, height: 300 });
});

it("drags the corner into a new box and remembers it on release", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  localStorage.setItem("agent-panel.terminal.tile-box", JSON.stringify({ ":tile-2": { width: 400, height: 300 } }));
  const view = render(
    <TerminalTile feed={feed} session={{ name: "tile-2" }} storageKey=":tile-2" onAttachImage={() => {}} />,
  );
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  const handle = screen.getByRole("button", { name: "Resize tile-2 terminal" });
  // Forty pixels right and thirty-two down, in two moves: the box follows per pixel
  // while the badge names it, and nothing reaches the pane at any point.
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 20, clientY: 16, pointerId: 1 });
  expect(tileBoxOf(view.container)).toEqual({ width: 420, height: 316 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  expect(tileBoxOf(view.container)).toEqual({ width: 440, height: 332 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(loadTileBox(":tile-2")).toEqual({ width: 440, height: 332 });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
});

it("ignores a drag without a matching axis and a press without a cell", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  localStorage.removeItem("agent-panel.terminal.tile-box");
  render(<TerminalTile feed={feed} session={{ name: "tile-3" }} storageKey=":tile-3" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  // No arranged box and no measurable mount in jsdom: a keyboard press has no step and
  // no start, so nothing is stored and nothing is asked for.
  fireEvent.keyDown(screen.getByRole("button", { name: "Resize tile-3 terminal" }), { key: "ArrowRight" });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
  expect(loadTileBox(":tile-3")).toBeNull();
});

it("drags the right edge into width alone and remembers it", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  localStorage.setItem("agent-panel.terminal.tile-box", JSON.stringify({ ":tile-4": { width: 400, height: 300 } }));
  const view = render(
    <TerminalTile feed={feed} session={{ name: "tile-4" }} storageKey=":tile-4" onAttachImage={() => {}} />,
  );
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  const handle = screen.getByRole("button", { name: "Resize tile-4 terminal width" });
  // Forty pixels right with thirty-two of vertical drift: only the width follows.
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  expect(tileBoxOf(view.container)).toEqual({ width: 440, height: 300 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(loadTileBox(":tile-4")).toEqual({ width: 440, height: 300 });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
});

it("drags the bottom edge into height alone and remembers it", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  localStorage.setItem("agent-panel.terminal.tile-box", JSON.stringify({ ":tile-5": { width: 400, height: 300 } }));
  const view = render(
    <TerminalTile feed={feed} session={{ name: "tile-5" }} storageKey=":tile-5" onAttachImage={() => {}} />,
  );
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  const handle = screen.getByRole("button", { name: "Resize tile-5 terminal height" });
  // Forty pixels of horizontal drift with thirty-two down: only the height follows.
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  expect(tileBoxOf(view.container)).toEqual({ width: 400, height: 332 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(loadTileBox(":tile-5")).toEqual({ width: 400, height: 332 });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
});

it("shows the pane's shape in the footer, live through a drag", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  localStorage.setItem("agent-panel.terminal.tile-box", JSON.stringify({ ":tile-size": { width: 400, height: 300 } }));
  render(<TerminalTile feed={feed} session={{ name: "tile-size" }} storageKey=":tile-size" onAttachImage={() => {}} />);
  // Before the attach answers, the opening grid stands in.
  expect(screen.getByLabelText("Terminal size")).toHaveTextContent("60×30");
  // The attach answers with the pane's shape, which is what the footer reads: the box
  // is the reader's and the grid the pane's, and the two are different facts.
  await waitFor(() => expect(screen.getByLabelText("Terminal size")).toHaveTextContent("100×30"));

  const handle = screen.getByRole("button", { name: "Resize tile-size terminal" });
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  // Forty pixels right and thirty-two down from the arranged box: the footer tracks the
  // drag per pixel while the pane's shape stands behind it.
  expect(screen.getByLabelText("Terminal size")).toHaveTextContent("440×332");
  fireEvent.pointerUp(handle, { pointerId: 1 });
});

it("attaches through the footer picker", async () => {
  const feed = feedDouble();
  const onAttachImage = vi.fn();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  localStorage.removeItem("agent-panel.terminal.tile-box");
  const view = render(
    <TerminalTile feed={feed} session={{ name: "tile-7" }} storageKey=":tile-7" onAttachImage={onAttachImage} />,
  );
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  // The button carries the name; the input beside it is unlabelled, so the change goes to
  // the file input inside the same footer.
  fireEvent.click(screen.getByRole("button", { name: "Attach an image to tile-7" }));
  const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
  const picker = view.container.querySelector('footer input[type="file"]');
  expect(picker).toBeTruthy();
  fireEvent.change(picker!, { target: { files: [file] } });
  expect(onAttachImage).toHaveBeenCalledWith([file]);
});

it("keeps an oversized grid reachable by scrolling instead of clipping it", () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  const view = render(
    <TerminalTile feed={feed} session={{ name: "tile-scroll" }} storageKey=":tile-scroll" onAttachImage={() => {}} />,
  );
  // The mount scrolls on both axes with a screen that never shrink-wraps away: a tile
  // dragged past its card clips without this, and the cut-off columns are unreachable.
  const mount = view.container.querySelector("section > div");
  expect(mount?.className).toContain("overflow-auto");
  expect(mount?.className).toContain("[&>.xterm]:shrink-0");
});
