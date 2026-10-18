import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useCanvasZoom } from "@/features/bots/canvas/useCanvasZoom";
import { TerminalCanvas } from "@/features/terminal/canvas/strip/TerminalCanvas";
import { groupTerminalsByDirectory } from "@/features/terminal/canvas/terminalGroups";
import { terminalParentHues, terminalParentRanks } from "@/features/terminal/canvas/terminalSurface";

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  readonly options: Record<string, unknown>;
  readonly writes: string[] = [];
  readonly buffer = {
    active: { type: "normal" as "normal" | "alternate", cursorY: 0, viewportY: 0, getLine: () => undefined },
  };
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
  wheel: ((event: WheelEvent) => boolean) | null = null;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
  open(element: HTMLElement) {
    this.element = element;
    this.textarea = element.ownerDocument.createElement("textarea");
    element.append(this.textarea);
  }
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this.wheel = handler;
  }
  scrollLines() {}
  clear() {}
  reset() {}
  resize() {}
  focus() {
    this.textarea?.focus();
  }
  dispose() {}
  write(bytes: Uint8Array, done: () => void) {
    this.writes.push(new TextDecoder().decode(bytes));
    done();
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

// Through to the real hook, recording its calls: the canvas under test passes the mode flag,
// and what this pins is the value it passes while the strip is and is not in the page.
vi.mock("@/features/bots/canvas/useCanvasZoom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/bots/canvas/useCanvasZoom")>();
  return { ...actual, useCanvasZoom: vi.fn(actual.useCanvasZoom) };
});

function session(name: string, path: string, attachedClients = 0) {
  return { name, windows: 1, attachedClients, path, windowList: [] };
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
  const grouping = groupTerminalsByDirectory([
    {
      machineLabel: "mac",
      sessions: [session("a", "/proj"), session("b", "/proj", 2), session("solo", "/other")],
      workspaceRoots: ["/empty"],
      botDirs: [],
    },
  ]);
  const hues = terminalParentHues([
    ...grouping.parents.map((parent) => ({ key: parent.key, path: parent.path })),
    ...grouping.residue.map((parent) => ({ key: parent.key, path: parent.path })),
  ]);
  const ranks = terminalParentRanks([
    ...grouping.parents.map((parent) => ({ key: parent.key, path: parent.path })),
    ...grouping.residue.map((parent) => ({ key: parent.key, path: parent.path })),
  ]);
  return {
    grouping,
    hues,
    ranks,
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
    activeOnly: false,
    onToggleActiveOnly: vi.fn(),
    canvasZoom: { mode: false, room: 0 },
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
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledWith({ kind: "tmux", session: "a" }, 60, 30));
  expect(screen.getByLabelText("a terminal")).toBeTruthy();

  view.rerender(<TerminalCanvas {...props} openChildren={new Set()} />);
  await waitFor(() => expect(feed.closeTerminal).toHaveBeenCalledWith("terminal-1", "kill"));
  expect(screen.queryByLabelText("a terminal")).toBeNull();
});

it("kills only through the confirmed menu, and reports the failure on the card", async () => {
  const feed = feedFake({
    killTmuxSession: vi.fn(async () => {
      throw new Error("tmux: no such session");
    }),
  });
  const onKillChild = vi.fn(async () => {
    await feed.killTmuxSession("a");
  });
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

it("starts a shell under the offered default, dir plus one past the count", () => {
  const feed = feedFake();
  const onAddTerminal = vi.fn();
  render(<TerminalCanvas {...canvasProps(feed, { onAddTerminal })} />);

  // Three sessions stand on this machine, so the offer steps past all of them.
  fireEvent.click(screen.getByRole("button", { name: "Start a shell in proj" }));
  expect((screen.getByLabelText("Name the new shell") as HTMLInputElement).value).toBe("proj-4");

  // Accepting the default is one press: the parent and the offered name travel together.
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(onAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ path: "/proj" }), "proj-4");
});

it("lets the reader name the shell, restores the default, and refuses a collision", () => {
  const feed = feedFake();
  const onAddTerminal = vi.fn();
  render(<TerminalCanvas {...canvasProps(feed, { onAddTerminal })} />);

  fireEvent.click(screen.getByRole("button", { name: "Start a shell in proj" }));
  const field = screen.getByLabelText("Name the new shell") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "my-shell" } });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(onAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ path: "/proj" }), "my-shell");

  // Typed over, then thought better of: Use default puts the offer back.
  fireEvent.click(screen.getByRole("button", { name: "Start a shell in proj" }));
  const reopened = screen.getByLabelText("Name the new shell") as HTMLInputElement;
  fireEvent.change(reopened, { target: { value: "my-shell" } });
  fireEvent.click(screen.getByRole("button", { name: "Use default" }));
  expect((screen.getByLabelText("Name the new shell") as HTMLInputElement).value).toBe("proj-4");

  // A name standing anywhere on this machine is a join, so the form refuses it outright.
  fireEvent.change(screen.getByLabelText("Name the new shell"), { target: { value: "a" } });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(screen.getByRole("alert")).toHaveTextContent("already standing");
  expect(onAddTerminal).toHaveBeenCalledTimes(1);
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
  render(
    <TerminalCanvas
      {...canvasProps(feed, {
        offStripChildren: new Set([":b"]),
        onShowHiddenChildren,
      })}
    />,
  );

  expect(screen.queryByText("b")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 1 hidden session" }));
  expect(onShowHiddenChildren).toHaveBeenCalledWith(":/proj");
});

it("holds the zoom off until the strip mounts, so a restored mode measures", () => {
  // A reload with the mode restored as ON shows the placeholder while the listing loads, so
  // neither node the zoom measures exists yet. The hook measures on the flip of `on`, so the
  // canvas passes the bare mode only once the strip is in the page -- passing it throughout
  // left the canvas unmeasured at 1:1 forever, its stored scale intact but never drawn.
  const feed = feedFake();
  const zoomed = vi.mocked(useCanvasZoom);
  zoomed.mockClear();
  const props = canvasProps(feed, { loading: true, canvasZoom: { mode: true, room: 0 } });
  const view = render(<TerminalCanvas {...props} />);
  expect(zoomed.mock.calls.at(-1)?.[0].on).toBe(false);

  // The listing lands and the strip mounts: the flip to true is what measures it.
  view.rerender(<TerminalCanvas {...props} loading={false} />);
  expect(zoomed.mock.calls.at(-1)?.[0].on).toBe(true);

  // No strip, no mode either: an error shows the placeholder, not a measured canvas.
  view.rerender(<TerminalCanvas {...props} loading={false} error="sidecar is down" />);
  expect(zoomed.mock.calls.at(-1)?.[0].on).toBe(false);
});

it("drops an image onto a closed row and pastes its path through the session", async () => {
  const dropTmuxSessionImage = vi.fn(async () => {});
  const feed = feedFake({ dropTmuxSessionImage });
  render(<TerminalCanvas {...canvasProps(feed)} />);

  const row = screen.getByRole("button", { name: "a unattached · 1 window" });
  // The overlay names the contract while the file is over the card: a path paste, not a
  // composer, because this card has none.
  fireEvent.dragOver(row, { dataTransfer: { files: [], types: ["Files"] } });
  expect(screen.getByText("Drop to paste the image path")).toBeTruthy();

  const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
  fireEvent.drop(row, { dataTransfer: { files: [file], types: ["Files"] } });
  await waitFor(() => expect(dropTmuxSessionImage).toHaveBeenCalledWith("a", file));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("refuses an oversize image on the card and sends nothing", async () => {
  const dropTmuxSessionImage = vi.fn(async () => {});
  const feed = feedFake({ dropTmuxSessionImage });
  render(<TerminalCanvas {...canvasProps(feed)} />);

  const file = new File(["x".repeat(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
  fireEvent.drop(screen.getByRole("button", { name: "a unattached · 1 window" }), {
    dataTransfer: { files: [file], types: ["Files"] },
  });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("An image has to be under 10 MB.")).toBeTruthy();
  expect(dropTmuxSessionImage).not.toHaveBeenCalled();
});

it("attaches through the menu picker, reporting a refusal on the card", async () => {
  const dropTmuxSessionImage = vi.fn(async () => {
    throw new Error("tmux: no such session");
  });
  const feed = feedFake({ dropTmuxSessionImage });
  render(<TerminalCanvas {...canvasProps(feed)} />);

  fireEvent.click(screen.getByRole("button", { name: "Actions for a terminal" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Attach image…" }));
  const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Attach an image to a"), {
    target: { files: [file] },
  });
  await waitFor(() => expect(dropTmuxSessionImage).toHaveBeenCalledWith("a", file));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("tmux: no such session")).toBeTruthy();
});

it("lists a multi-window session's windows with the active one marked, and opens one on its target", async () => {
  const feed = feedFake();
  const grouping = groupTerminalsByDirectory([
    {
      machineLabel: "mac",
      sessions: [
        {
          name: "harbor",
          windows: 4,
          attachedClients: 0,
          path: "/proj",
          windowList: [
            {
              index: 0,
              name: "zsh",
              active: false,
              panes: [{ index: 0, active: true, command: "zsh", path: "/proj" }],
            },
            {
              index: 1,
              name: "backend",
              active: true,
              panes: [{ index: 0, active: true, command: "node", path: "/proj" }],
            },
          ],
        },
      ],
      workspaceRoots: [],
      botDirs: [],
    },
  ]);
  const props = canvasProps(feed, { grouping });
  const view = render(<TerminalCanvas {...props} />);

  // The active window says so; the idle one does not.
  expect(screen.getByTitle("Open harbor:1 (active window)")).toBeTruthy();
  expect(screen.getByTitle("Open harbor:0")).toBeTruthy();
  // Single-pane windows stay flat: no pane rows, no expander.
  expect(screen.queryByRole("list", { name: "harbor:1 panes" })).toBeNull();

  // Opening from above mounts a tile attached at the window target, not the session.
  view.rerender(<TerminalCanvas {...props} openChildren={new Set([":harbor:1"])} />);
  await waitFor(() => expect(feed.openTerminal).toHaveBeenCalledWith({ kind: "tmux", session: "harbor:1" }, 60, 30));
  expect(screen.getByLabelText("harbor:1 terminal")).toBeTruthy();
});

it("flips the active-only arrangement from the strip's own chip", () => {
  const feed = feedFake();
  const onToggleActiveOnly = vi.fn();
  render(<TerminalCanvas {...canvasProps(feed, { onToggleActiveOnly })} />);
  const chip = screen.getByRole("button", { name: "Active only" });
  expect(chip).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(chip);
  expect(onToggleActiveOnly).toHaveBeenCalledTimes(1);
});
