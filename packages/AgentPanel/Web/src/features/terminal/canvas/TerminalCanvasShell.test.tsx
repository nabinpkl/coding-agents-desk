import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalCanvasShell } from "@/features/terminal/canvas/TerminalCanvasShell";

let terminal: FakeTerminal;

class FakeTerminal {
  readonly dimensions = { css: { cell: { width: 8, height: 16 } } };
  readonly options: Record<string, unknown>;
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
  write(_bytes: Uint8Array, done: () => void) { done(); }
  onData() { return { dispose: () => {} }; }
  onBinary() { return { dispose: () => {} }; }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));

function session(name: string, path: string) {
  return { name, windows: 1, attachedClients: 0, path, windowList: [] };
}

function machineFeed(sessions: unknown[], roots: string[] = [], bots: unknown[] = []) {
  return {
    listTmuxSessions: vi.fn(async () => sessions),
    listWorkspaces: vi.fn(async () => roots.map((root, index) => ({ id: `w${index}`, name: root, root }))),
    subscribeBots: vi.fn((onSnapshot: (snapshot: unknown) => void) => {
      onSnapshot({ version: 2, revision: 1, bots });
      return () => {};
    }),
    openTerminal: vi.fn(async () => ({
      terminalId: "terminal-9",
      ptySessionName: "agent-tmux-agentterm-new",
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
  } as unknown as SidecarDataSource;
}

it("stands every machine's directories on one strip", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj", "/empty"]);
  const peer = machineFeed([session("b", "/proj")], []);
  render(<TerminalCanvasShell
    feed={home}
    machines={[
      { label: "mac", feed: home },
      { id: "peer", label: "peer", feed: peer },
    ]}
  />);

  // The same path on two machines stands twice, labelled; the empty root stands as a starter.
  const canvas = await screen.findByRole("list", { name: "Terminal canvas" });
  const canvasScope = within(canvas);
  const paths = canvasScope.getAllByText("/proj");
  expect(paths).toHaveLength(2);
  // Both of this machine's parents caption it; the peer's one captions its own.
  expect(canvasScope.getAllByText("mac")).toHaveLength(2);
  expect(canvasScope.getByText("peer")).toBeTruthy();
  expect(canvasScope.getByText("empty")).toBeTruthy();
  expect(canvasScope.getByText("Empty — start a shell with +")).toBeTruthy();

  // The roster beside the strip names the same parents and the same sessions.
  const roster = screen.getByRole("list", { name: "Terminal parents" });
  const rosterScope = within(roster);
  expect(rosterScope.getAllByText("/proj")).toHaveLength(2);
  expect(rosterScope.getByRole("button", { name: "a unattached · 1 window" })).toBeTruthy();
  expect(rosterScope.getByRole("button", { name: "b unattached · 1 window" })).toBeTruthy();
});

it("starts a shell in the parent's directory and opens it", async () => {
  const sessions = [session("a", "/proj")];
  const home = machineFeed(sessions, ["/proj"]);
  // The listing reports what the sidecar started, the way tmux does: the create lands in the
  // next read without anyone refreshing by hand.
  vi.mocked(home.listTmuxSessions).mockImplementation(async () => [...sessions]);
  vi.mocked(home.openTerminal).mockImplementation(async (context) => {
    const target = context as { kind: string; session?: string; directory?: string };
    if (target.kind === "tmux-new" && target.session && target.directory) {
      sessions.push({ name: target.session, windows: 1, attachedClients: 0, path: target.directory, windowList: [] });
    }
    return {
      terminalId: "terminal-9",
      ptySessionName: "agent-tmux-agentterm-new",
      pid: 7,
      columns: 80,
      rows: 24,
      mouseReporting: false,
    };
  });
  render(<TerminalCanvasShell feed={home} machines={undefined} />);

  // The card's own add button, not the roster's: both name the same leaf.
  const canvas = await screen.findByRole("list", { name: "Terminal canvas" });
  fireEvent.click(within(canvas).getByRole("button", { name: "Start a shell in proj" }));
  // Offered under dir-plus-count -- one session stands, so the default steps past it -- and
  // taken as offered with one press on Start.
  const canvasScope = within(canvas);
  expect((canvasScope.getByLabelText("Name the new shell") as HTMLInputElement).value).toBe("proj-2");
  fireEvent.click(canvasScope.getByRole("button", { name: "Start" }));
  // Created as a login shell in that directory, and immediately released so the tile
  // joining it does not fight the create for the pane's one pipe.
  await waitFor(() => expect(home.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux-new", session: "proj-2", directory: "/proj" },
    60,
    30,
  ));
  expect(home.closeTerminal).toHaveBeenCalledWith("terminal-9", "detach");
  // The new session opens itself once the listing reports it -- no refresh pressed.
  await waitFor(() => expect(home.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux", session: "proj-2" },
    60,
    30,
  ));
});

it("starts a shell from the roster under a typed name", async () => {
  const sessions = [session("a", "/proj")];
  const home = machineFeed(sessions, ["/proj"]);
  vi.mocked(home.listTmuxSessions).mockImplementation(async () => [...sessions]);
  vi.mocked(home.openTerminal).mockImplementation(async (context) => {
    const target = context as { kind: string; session?: string; directory?: string };
    if (target.kind === "tmux-new" && target.session && target.directory) {
      sessions.push({ name: target.session, windows: 1, attachedClients: 0, path: target.directory, windowList: [] });
    }
    return {
      terminalId: "terminal-9",
      ptySessionName: `agent-tmux-${target.session}`,
      pid: 7,
      columns: 80,
      rows: 24,
      mouseReporting: false,
    };
  });
  render(<TerminalCanvasShell feed={home} machines={undefined} />);

  // The roster's own naming form, not the card's: a typed name travels the same shell path.
  const roster = await screen.findByRole("list", { name: "Terminal parents" });
  const rosterScope = within(roster);
  fireEvent.click(rosterScope.getByRole("button", { name: "Start a shell in proj" }));
  fireEvent.change(rosterScope.getByLabelText("Name the new shell"), { target: { value: "my-shell" } });
  fireEvent.click(rosterScope.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(home.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux-new", session: "my-shell", directory: "/proj" },
    60,
    30,
  ));
});

it("kills through the owning machine and drops the row with the listing", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  render(<TerminalCanvasShell feed={home} machines={undefined} />);
  const canvas = await screen.findByRole("list", { name: "Terminal canvas" });
  const canvasScope = within(canvas);
  canvasScope.getByText("proj");

  fireEvent.click(canvasScope.getByRole("button", { name: "Actions for a terminal" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Kill session" }));
  vi.mocked(home.listTmuxSessions).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "Kill it" }));

  await waitFor(() => expect(home.killTmuxSession).toHaveBeenCalledWith("a"));
  // The row goes with the listing; the registered directory stands on as the place a shell
  // gets started.
  await waitFor(() => expect(canvasScope.queryByRole("button", { name: "a unattached · 1 window" })).toBeNull());
  expect(canvasScope.getByText("Empty — start a shell with +")).toBeTruthy();
});

it("says which machine is not answering instead of showing its sessions as gone", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  const peer = machineFeed([], []);
  vi.mocked(peer.listTmuxSessions).mockRejectedValue(new Error("connection refused"));
  render(<TerminalCanvasShell
    feed={home}
    machines={[
      { label: "mac", feed: home },
      { id: "peer", label: "peer", feed: peer },
    ]}
  />);

  // Both surfaces say it, in their own words: the strip and the roster each read the shell's
  // machine errors rather than one deriving from the other.
  expect((await screen.findAllByText(/peer is not answering/)).map((node) => node.textContent)).toEqual([
    expect.stringContaining("so its sessions are not listed: connection refused"),
    expect.stringContaining("so its sessions are not on the canvas: connection refused"),
  ]);
  // The healthy machine's cards stand anyway, on the strip and in the roster.
  expect(screen.getAllByText("proj").length).toBeGreaterThanOrEqual(2);
});

it("opens a session on the canvas from the roster", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  render(<TerminalCanvasShell feed={home} machines={undefined} />);
  const roster = await screen.findByRole("list", { name: "Terminal parents" });
  fireEvent.click(within(roster).getByRole("button", { name: "a unattached · 1 window" }));

  // Joining the standing session, the way opening from a card does.
  await waitFor(() => expect(home.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux", session: "a" },
    60,
    30,
  ));
});

it("takes a parent off the strip from the roster and puts it back", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  render(<TerminalCanvasShell feed={home} machines={undefined} />);
  const roster = await screen.findByRole("list", { name: "Terminal parents" });
  const rosterScope = within(roster);
  const canvas = screen.getByRole("list", { name: "Terminal canvas" });
  expect(within(canvas).getByText("/proj")).toBeTruthy();

  fireEvent.click(rosterScope.getByRole("button", { name: "Take proj off the strip" }));
  // The card leaves the strip; the row stays listed as the way back.
  await waitFor(() => expect(within(canvas).queryByText("/proj")).toBeNull());
  expect(rosterScope.getByRole("button", { name: "Put proj on the strip" })).toBeTruthy();

  fireEvent.click(rosterScope.getByRole("button", { name: "Put proj on the strip" }));
  await waitFor(() => expect(within(canvas).getByText("/proj")).toBeTruthy());
});

it("closes the roster to a rail and reopens it", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  render(<TerminalCanvasShell feed={home} machines={undefined} />);
  await screen.findByRole("list", { name: "Terminal parents" });

  fireEvent.click(screen.getByRole("button", { name: "Close terminal list" }));
  expect(screen.queryByRole("list", { name: "Terminal parents" })).toBeNull();
  expect(screen.getByRole("button", { name: "Show terminal list" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Show terminal list" }));
  expect(screen.getByRole("list", { name: "Terminal parents" })).toBeTruthy();
});

it("fits the whole strip from the roster, on its own storage keys", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  render(<TerminalCanvasShell feed={home} machines={undefined} />);
  await screen.findByRole("list", { name: "Terminal parents" });

  fireEvent.click(screen.getByRole("button", { name: "Fit the whole strip" }));
  expect(localStorage.getItem("agent-panel.terminal-canvas.zoom-mode")).toBe("on");
  // The Bot canvas keeps its own answer: one canvas's fit must never open the other drawn small.
  expect(localStorage.getItem("agent-panel.bot-canvas.zoom-mode")).toBeNull();

  // Room chips wake up with the mode, and persist under the terminal key too.
  fireEvent.click(screen.getByRole("button", { name: "64" }));
  expect(localStorage.getItem("agent-panel.terminal-canvas.room")).toBe("64");
});

it("wears faces on cards and rows once the switch is pressed", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  const view = render(<TerminalCanvasShell feed={home} machines={undefined} />);
  await screen.findByRole("list", { name: "Terminal parents" });
  expect(view.container.querySelector("svg.bot-face")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show session faces instead of initials" }));
  // The parent's face on its card and in the roster, and the session's own on both.
  await waitFor(() => expect(view.container.querySelectorAll("svg.bot-face").length).toBeGreaterThanOrEqual(4));

  fireEvent.click(screen.getByRole("button", { name: "Show session initials instead of faces" }));
  await waitFor(() => expect(view.container.querySelector("svg.bot-face")).toBeNull());
});
