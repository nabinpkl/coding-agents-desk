import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  return { name, windows: 1, attachedClients: 0, path };
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
  const paths = await screen.findAllByText("/proj");
  expect(paths).toHaveLength(2);
  // Both of this machine's parents caption it; the peer's one captions its own.
  expect(screen.getAllByText("mac")).toHaveLength(2);
  expect(screen.getByText("peer")).toBeTruthy();
  expect(screen.getByText("empty")).toBeTruthy();
  expect(screen.getByText("Empty — start a shell with +")).toBeTruthy();
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
      sessions.push({ name: target.session, windows: 1, attachedClients: 0, path: target.directory });
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

  fireEvent.click(await screen.findByRole("button", { name: "Start a shell in proj" }));
  // Minted, created as a login shell in that directory, and immediately released so the tile
  // joining it does not fight the create for the pane's one pipe.
  await waitFor(() => expect(home.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux-new", session: expect.stringMatching(/^agentterm-[0-9a-f]{8}$/), directory: "/proj" },
    80,
    24,
  ));
  expect(home.closeTerminal).toHaveBeenCalledWith("terminal-9", "detach");
  // The new session opens itself once the listing reports it -- no refresh pressed.
  const minted = vi.mocked(home.openTerminal).mock.calls[0]![0] as { session: string };
  await waitFor(() => expect(home.openTerminal).toHaveBeenCalledWith(
    { kind: "tmux", session: minted.session },
    80,
    24,
  ));
});

it("kills through the owning machine and drops the row with the listing", async () => {
  const home = machineFeed([session("a", "/proj")], ["/proj"]);
  render(<TerminalCanvasShell feed={home} machines={undefined} />);
  await screen.findByText("proj");

  fireEvent.click(screen.getByRole("button", { name: "Actions for a terminal" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Kill session" }));
  vi.mocked(home.listTmuxSessions).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "Kill it" }));

  await waitFor(() => expect(home.killTmuxSession).toHaveBeenCalledWith("a"));
  // The row goes with the listing; the registered directory stands on as the place a shell
  // gets started.
  await waitFor(() => expect(screen.queryByRole("button", { name: "a unattached · 1 window" })).toBeNull());
  expect(screen.getByText("Empty — start a shell with +")).toBeTruthy();
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

  expect(await screen.findByText(/peer is not answering/)).toBeTruthy();
  // The healthy machine's cards stand anyway.
  expect(screen.getByText("proj")).toBeTruthy();
});
