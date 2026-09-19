import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalCanvas } from "@/features/terminal/canvas/TerminalCanvas";
import { groupTerminalsByDirectory } from "@/features/terminal/canvas/terminalGroups";
import { terminalParentHues } from "@/features/terminal/canvas/terminalSurface";

let terminal: FakeTerminal;

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  readonly options: Record<string, unknown>;
  readonly writes: string[] = [];
  readonly buffer = { active: { type: "normal" as "normal" | "alternate" } };
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
  wheel: ((event: WheelEvent) => boolean) | null = null;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    terminal = this;
  }
  open(element: HTMLElement) {
    this.element = element;
    this.textarea = element.ownerDocument.createElement("textarea");
    element.append(this.textarea);
  }
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) { this.wheel = handler; }
  scrollLines() {}
  clear() {}
  reset() {}
  resize() {}
  focus() { this.textarea?.focus(); }
  dispose() {}
  write(bytes: Uint8Array, done: () => void) {
    this.writes.push(new TextDecoder().decode(bytes));
    done();
  }
  onData() { return { dispose: () => {} }; }
  onBinary() { return { dispose: () => {} }; }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));

function session(name: string, path: string, attachedClients = 0) {
  return { name, windows: 1, attachedClients, path };
}

function feedFake(overrides: Partial<SidecarDataSource> = {}) {
  return {
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-1",
      ptySessionName: "agent-tmux-a",
      pid: 7,
      columns: 80,
      rows: 24,
    })),
    subscribeTerminal: vi.fn(() => () => {}),
    terminalHistory: vi.fn(async () => ""),
    updateTerminalViewport: vi.fn(async () => {}),
    sendTerminalInput: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
    killTmuxSession: vi.fn(async () => {}),
    ...overrides,
  } as unknown as SidecarDataSource;
}

function canvasProps(feed: SidecarDataSource, overrides: Record<string, unknown> = {}) {
  const grouping = groupTerminalsByDirectory([{
    machineLabel: "mac",
    sessions: [session("a", "/proj"), session("b", "/proj", 2), session("solo", "/other")],
    workspaceRoots: ["/empty"],
    botDirs: [],
  }]);
  const hues = terminalParentHues([
    ...grouping.parents.map((parent) => ({ key: parent.key, path: parent.path })),
    ...grouping.residue.map((parent) => ({ key: parent.key, path: parent.path })),
  ]);
  return {
    grouping,
    hues,
    loading: false,
    error: null,
    machineErrors: [],
    machines: [],
    hiddenMachines: new Set<string>(),
    onToggleMachine: vi.fn(),
    feedFor: () => feed,
    hiddenParents: new Set<string>(),
    onHideParent: vi.fn(),
    onShowParent: vi.fn(),
    offStripChildren: new Set<string>(),
    onHideChild: vi.fn(),
    onShowHiddenChildren: vi.fn(),
    openChildren: new Set<string>(),
    onToggleChild: vi.fn(),
    onKillChild: vi.fn(async () => {}),
    addingKeys: new Set<string>(),
    addErrors: new Map<string, string>(),
    onAddTerminal: vi.fn(),
    onDismissAddError: vi.fn(),
    orphanedError: null,
    onRefresh: vi.fn(),
    ...overrides,
  };
}

it("stands one parent per directory with name-sorted sessions inside", () => {
  const feed = feedFake();
  render(<TerminalCanvas {...canvasProps(feed)} />);

  expect(screen.getByRole("list", { name: "Terminal canvas" })).toBeTruthy();
  expect(screen.getByRole("list", { name: "proj sessions" })).toBeTruthy();
  expect(screen.getByText("proj")).toBeTruthy();
  expect(screen.getByText("/proj")).toBeTruthy();
  // Name-sorted, not arrival order: the unwatched session stands before the watched one.
  const list = screen.getByRole("list", { name: "proj sessions" });
  const proj = within(list);
  const first = proj.getByRole("button", { name: "a unattached · 1 window" });
  const second = proj.getByRole("button", { name: "b 2 watching · 1 window" });
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The watched session says so; the unwatched one says unattached.
  expect(proj.getByText("2 watching · 1 window")).toBeTruthy();
  expect(proj.getByText("unattached · 1 window")).toBeTruthy();
  // An empty registered directory still stands, as the place a shell gets started.
  expect(screen.getByText("empty")).toBeTruthy();
  expect(screen.getByText("Empty — start a shell with +")).toBeTruthy();
});

it("opens a row's tile on its own tmux attach, and closes it back to a row", async () => {
  const feed = feedFake();
  const onToggleChild = vi.fn();
  const props = canvasProps(feed, { onToggleChild });
  const view = render(<TerminalCanvas {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "a unattached · 1 window" }));

  expect(onToggleChild).toHaveBeenCalledWith(":a");

  // Open from above: the tile mounts and attaches to the session it names.
  view.rerender(<TerminalCanvas {...props} openChildren={new Set([":a"])} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledWith({ kind: "tmux", session: "a" }, 80, 24));
  expect(screen.getByLabelText("a terminal")).toBeTruthy();

  view.rerender(<TerminalCanvas {...props} openChildren={new Set()} />);
  await waitFor(() => expect(feed.closeTerminal).toHaveBeenCalledWith("terminal-1", "kill"));
  expect(screen.queryByLabelText("a terminal")).toBeNull();
});

it("kills only through the confirmed menu, and reports the failure on the card", async () => {
  const feed = feedFake({
    killTmuxSession: vi.fn(async () => { throw new Error("tmux: no such session"); }),
  });
  const onKillChild = vi.fn(async () => { await feed.killTmuxSession("a"); });
  render(<TerminalCanvas {...canvasProps(feed, { onKillChild })} />);

  // Mere menu does not kill.
  fireEvent.click(screen.getByRole("button", { name: "Actions for a terminal" }));
  expect(feed.killTmuxSession).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("menuitem", { name: "Kill session" }));
  expect(screen.getByRole("alertdialog", { name: "Kill a?" })).toBeTruthy();
  expect(feed.killTmuxSession).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Kill it" }));
  await waitFor(() => expect(feed.killTmuxSession).toHaveBeenCalledWith("a"));
  expect(await screen.findByRole("alert")).toHaveTextContent("tmux: no such session");
});

it("starts a shell from the parent that owns the directory", () => {
  const feed = feedFake();
  const onAddTerminal = vi.fn();
  render(<TerminalCanvas {...canvasProps(feed, { onAddTerminal })} />);

  fireEvent.click(screen.getByRole("button", { name: "Start a shell in proj" }));
  expect(onAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ path: "/proj" }));
});

it("hides a parent off the strip and brings it back from the strip's end", () => {
  const feed = feedFake();
  const onHideParent = vi.fn();
  const props = canvasProps(feed, { onHideParent });
  const view = render(<TerminalCanvas {...props} />);

  fireEvent.click(screen.getByRole("button", { name: "Actions for proj directory" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Hide parent" }));
  expect(onHideParent).toHaveBeenCalledWith(":/proj");

  // Hidden from above: the card is gone and the strip's end names the way back.
  view.rerender(<TerminalCanvas {...props} hiddenParents={new Set([":/proj"])} />);
  expect(screen.queryByText("proj")).toBeNull();
  expect(screen.getByRole("region", { name: "Hidden parents" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "proj · this machine" }));
  expect(props.onShowParent).toHaveBeenCalledWith(":/proj");
});

it("names hidden children in the parent and shows them back on one press", () => {
  const feed = feedFake();
  const onShowHiddenChildren = vi.fn();
  render(<TerminalCanvas {...canvasProps(feed, {
    offStripChildren: new Set([":b"]),
    onShowHiddenChildren,
  })} />);

  expect(screen.queryByText("b")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 1 hidden session" }));
  expect(onShowHiddenChildren).toHaveBeenCalledWith(":/proj");
});
