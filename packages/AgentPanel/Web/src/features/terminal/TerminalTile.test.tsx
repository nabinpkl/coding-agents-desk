import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentTerminalStreamMessage } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalTile } from "@/features/terminal/TerminalTile";
import { loadTileGrid } from "@/features/terminal/terminalTileSize";

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  cols = 80;
  rows = 24;
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
  resize(columns: number, rows: number) { this.cols = columns; this.rows = rows; }
  focus() {}
  dispose() {}
  write(_data: unknown, done?: () => void) { done?.(); }
  onData() { return { dispose: () => {} }; }
  onBinary() { return { dispose: () => {} }; }
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

it("opens at the remembered grid and asks for a new one from the handle", async () => {
  const feed = feedDouble();
  localStorage.setItem(
    "agent-panel.terminal.tile-grid",
    JSON.stringify({ ":tile-1": { columns: 100, rows: 30 } }),
  );
  render(<TerminalTile feed={feed} session={{ name: "tile-1" }} storageKey=":tile-1" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux", session: "tile-1" },
    100,
    30,
  ));

  // The keyboard path: one press right asks for one more column and remembers it --
  // locally. The wall follows the pane and never claims its shape.
  fireEvent.keyDown(screen.getByRole("button", { name: "Resize tile-1 terminal" }), { key: "ArrowRight" });
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalledWith(
    "terminal-1",
    expect.objectContaining({ columns: 101, rows: 30, claim: false }),
  ));
  expect(loadTileGrid(":tile-1")).toEqual({ columns: 101, rows: 30 });
});

it("drags the corner into a new grid and remembers it on release", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  render(<TerminalTile feed={feed} session={{ name: "tile-2" }} storageKey=":tile-2" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());
  // The open publishes the opening grid; what follows belongs to the drag alone.
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalled());
  feed.updateTerminalViewport.mockClear();

  const handle = screen.getByRole("button", { name: "Resize tile-2 terminal" });
  // Five cells right (40px at 8px) and two rows down (32px at 16px) from 60x30, in two
  // moves: the moves stage the ask behind the badge, and the ask goes out on settle or
  // release -- so synchronously after the moves nothing has been asked yet.
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 20, clientY: 16, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  // Nothing is asked for on the same tick: every ask reflows the program inside the pane,
  // and a fullscreen TUI repaints itself on each one.
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalledTimes(1));
  expect(feed.updateTerminalViewport).toHaveBeenCalledWith(
    "terminal-1",
    expect.objectContaining({ columns: 65, rows: 32, claim: false }),
  );
  expect(loadTileGrid(":tile-2")).toEqual({ columns: 65, rows: 32 });
});

it("asks mid-drag once the pointer settles, then again on release", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  render(<TerminalTile feed={feed} session={{ name: "tile-6" }} storageKey=":tile-6" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalled());
  feed.updateTerminalViewport.mockClear();

  const handle = screen.getByRole("button", { name: "Resize tile-6 terminal" });
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  // The pointer rests: the staged grid is asked for while the drag is still in flight,
  // so the tile itself follows the badge instead of waiting for release.
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalledTimes(1), { timeout: 2000 });
  expect(feed.updateTerminalViewport).toHaveBeenCalledWith(
    "terminal-1",
    expect.objectContaining({ columns: 65, rows: 32 }),
  );
  // Moving again stages a new grid; release asks for it and remembers it.
  fireEvent.pointerMove(handle, { clientX: 80, clientY: 32, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalledTimes(2));
  expect(feed.updateTerminalViewport).toHaveBeenLastCalledWith(
    "terminal-1",
    expect.objectContaining({ columns: 70, rows: 32 }),
  );
  expect(loadTileGrid(":tile-6")).toEqual({ columns: 70, rows: 32 });
});

it("ignores a drag that never crosses a cell", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  render(<TerminalTile feed={feed} session={{ name: "tile-3" }} storageKey=":tile-3" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());

  const handle = screen.getByRole("button", { name: "Resize tile-3 terminal" });
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  // Two pixels: inside the cell, so nothing is asked for and nothing is stored.
  fireEvent.pointerMove(handle, { clientX: 2, clientY: 2, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
  expect(loadTileGrid(":tile-3")).toEqual({ columns: 60, rows: 30 });
});

it("drags the right edge into columns alone and remembers it", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  render(<TerminalTile feed={feed} session={{ name: "tile-4" }} storageKey=":tile-4" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalled());
  feed.updateTerminalViewport.mockClear();

  const handle = screen.getByRole("button", { name: "Resize tile-4 terminal width" });
  // Five cells right with two rows of vertical drift: only the columns follow.
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalledTimes(1));
  expect(feed.updateTerminalViewport).toHaveBeenCalledWith(
    "terminal-1",
    expect.objectContaining({ columns: 65, rows: 30 }),
  );
  expect(loadTileGrid(":tile-4")).toEqual({ columns: 65, rows: 30 });
});

it("drags the bottom edge into rows alone and remembers it", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  render(<TerminalTile feed={feed} session={{ name: "tile-5" }} storageKey=":tile-5" onAttachImage={() => {}} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalled());
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalled());
  feed.updateTerminalViewport.mockClear();

  const handle = screen.getByRole("button", { name: "Resize tile-5 terminal height" });
  // Five columns of horizontal drift with two rows down: only the rows follow.
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  expect(feed.updateTerminalViewport).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  await waitFor(() => expect(feed.updateTerminalViewport).toHaveBeenCalledTimes(1));
  expect(feed.updateTerminalViewport).toHaveBeenCalledWith(
    "terminal-1",
    expect.objectContaining({ columns: 60, rows: 32 }),
  );
  expect(loadTileGrid(":tile-5")).toEqual({ columns: 60, rows: 32 });
});

it("shows the pane's shape in the footer, live through a drag", async () => {
  const feed = feedDouble();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
  render(<TerminalTile feed={feed} session={{ name: "tile-size" }} storageKey=":tile-size" onAttachImage={() => {}} />);
  // Before the attach answers, the opening grid stands in.
  expect(screen.getByLabelText("Terminal size")).toHaveTextContent("60×30");
  // The attach answers with the pane's shape, which is what the footer reads.
  await waitFor(() => expect(screen.getByLabelText("Terminal size")).toHaveTextContent("100×30"));

  const handle = screen.getByRole("button", { name: "Resize tile-size terminal" });
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 32, pointerId: 1 });
  // Five cells right and two rows down from the opening grid: the footer tracks the drag
  // per pixel while the pane itself follows on settle.
  expect(screen.getByLabelText("Terminal size")).toHaveTextContent("65×32");
  fireEvent.pointerUp(handle, { pointerId: 1 });
});

it("attaches through the footer picker", async () => {
  const feed = feedDouble();
  const onAttachImage = vi.fn();
  localStorage.removeItem("agent-panel.terminal.tile-grid");
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
  const view = render(<TerminalTile feed={feed} session={{ name: "tile-scroll" }} storageKey=":tile-scroll" onAttachImage={() => {}} />);
  // The mount scrolls on both axes with a screen that never shrink-wraps away: a tile
  // dragged past its card clips without this, and the cut-off columns are unreachable.
  const mount = view.container.querySelector("section > div");
  expect(mount?.className).toContain("overflow-auto");
  expect(mount?.className).toContain("[&>.xterm]:shrink-0");
});
