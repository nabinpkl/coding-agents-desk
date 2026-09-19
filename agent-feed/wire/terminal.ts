/** One tmux session, as `GET /api/tmux/sessions` reports it. */
export interface TmuxSessionSummary {
  name: string;
  windows: number;
  /** Zero means nobody is looking at it right now, not that it has stopped. */
  attachedClients: number;
  /** The session's working directory, which is the closest thing it has to a project. */
  path: string;
}

/** A provider session whose CLI should be resumed inside the Agent Feed terminal. */
export interface AgentSessionTerminalContext {
  kind: "agent-session";
  projectPath: string;
  source: "claude" | "codex";
  sessionId: string;
}

/**
 * A tmux session to attach to, rather than a CLI to start.
 *
 * The distinction is the point: resuming a session opens a second client to a transcript, while
 * attaching shows the process somebody is already running. tmux is what makes the second viewer
 * legal, so watching a live agent goes through here and not through the resume above.
 */
export interface TmuxTerminalContext {
  kind: "tmux";
  /** As `GET /api/tmux/sessions` names it. */
  session: string;
}

/**
 * A provider session to watch in tmux, whether or not tmux is already running it.
 *
 * The two kinds above are the two answers to "is there a process yet", and a caller that only
 * knows a session id cannot pick between them: the panel would have to ask whether the session's
 * live process reports a tmux pane, and get null both for a session running outside tmux and for
 * one that is not running at all. This kind names the session and lets the sidecar decide -- attach
 * the pane the session is already in, otherwise start one that resumes it. Deciding it there is
 * also the only place it can be decided correctly, since between the panel's question and its open
 * the answer can change.
 */
export interface SessionTmuxTerminalContext {
  kind: "session-tmux";
  source: "claude" | "codex";
  sessionId: string;
}

/**
 * A tmux session to start when it is not running, and attach to when it is.
 *
 * The deliberate exception to the rule below that every context names something that already
 * exists. It starts nothing but a login shell -- no agent, no resume, no command -- in a caller
 * directory the sidecar vouches for, so there is no transcript to fork and no second client to a
 * live one. The panel mints the name (`agentterm-<8hex>`), and a collision is a join: both the
 * sidecar's existence check and tmux's own `-A` land on the running session.
 */
export interface NewTmuxTerminalContext {
  kind: "tmux-new";
  /** A plain tmux identifier, the way `TmuxTerminalContext.session` is. */
  session: string;
  /** Where the shell starts, vouched for like `WorkspaceTerminalContext.workspacePath`. */
  directory: string;
}

/*
 * Two contexts used to live here: `session-fork` and `session-new`, which named a session that did
 * not exist and started it as a side effect of attaching a viewer to it. They moved to
 * `BotLaunchCommand`, on the Bot that owns the directory the session works in.
 *
 * What is left is the property worth keeping: every context below names something that ALREADY
 * EXISTS, so opening a terminal has no side effects and asking twice is the same as asking once.
 * A session started through the Bot reports the tmux session it runs in, which is what
 * `TmuxTerminalContext` above takes.
 */

/**
 * A login shell in a registered workspace's root, owned by whoever opened it.
 *
 * The one context that is not pointed at an agent. The IDE's lower pane is a place to run `git
 * log` and `bun test` next to the file being read, and neither tmux kind is that: attaching to a
 * pane puts a second viewer on a session somebody else is working in, and the wall of every tmux
 * session on the machine answers a different question entirely.
 *
 * The PATH rather than the workspace id, because the id means nothing outside the IDE's own roster
 * and resolving it would put the workspace service inside the terminal service for one lookup.
 * What guards it is what already guards `AgentSessionTerminalContext.projectPath`: absolute,
 * existing, a directory, and inside the user's home.
 *
 * It still names something that already exists. The PTY session name is derived from the path, so
 * a second reader of one workspace joins the shell the first one opened instead of starting a
 * second in the same directory.
 */
export interface WorkspaceTerminalContext {
  kind: "workspace";
  /** The workspace root, as `WorkspaceSummary.root` gives it. */
  workspacePath: string;
}

/** What a terminal is pointed at. */
export type AgentTerminalContext =
  | AgentSessionTerminalContext
  | TmuxTerminalContext
  | SessionTmuxTerminalContext
  | NewTmuxTerminalContext
  | WorkspaceTerminalContext;

/** `POST /api/terminals` request. */
export interface OpenAgentTerminalRequest {
  context: AgentTerminalContext;
  columns: number;
  rows: number;
}

/** `POST /api/terminals` response. */
export interface AgentTerminalDescriptor {
  terminalId: string;
  ptySessionName: string;
  pid: number;
  columns: number;
  rows: number;
  /**
   * Whether the program in this pane has asked for mouse reports, in SGR form, so a viewer may
   * forward its wheel to the program instead of scrolling its own buffer.
   *
   * It exists because a fullscreen program has no tmux scrollback to import -- tmux keeps none for
   * the alternate screen -- so the only history that can be scrolled is the program's own, and the
   * only way to reach it is to send the wheel. Measured 2026-09-18 on a peer running Claude Code
   * with `"tui": "fullscreen"`: the pane reported `mouse_all_flag=1 mouse_sgr_flag=1`, and five
   * forwarded `ESC [ < 64 ; col ; row M` reports scrolled its view back through content that
   * `capture-pane` could not see at all.
   *
   * SGR specifically, and false for every other encoding, because the legacy X10 form cannot
   * address a column past 223 and a wheel report sent in the wrong encoding does not fail -- it
   * arrives in the program as text.
   *
   * A property of the program as it stood when this terminal opened. A pane that enters or leaves
   * fullscreen while somebody is watching is covered by the other half of the viewer's condition,
   * which reads xterm's own buffer type and follows the live stream; see `attachCustomWheelEventHandler`.
   */
  mouseReporting: boolean;
}

/** One terminal's message, carried inside an envelope on the shared stream. */
export type AgentTerminalStreamMessage =
  | {
      type: "checkpointBegin";
      checkpointId: string;
      revision: string;
      columns: number;
      rows: number;
      totalBytes: string;
      chunkCount: number;
      historyTruncated: boolean;
    }
  | { type: "checkpointChunk"; checkpointId: string; index: number; data: string }
  | { type: "checkpointEnd"; checkpointId: string; revision: string }
  | { type: "output"; revision: string; data: string }
  | {
      type: "viewport";
      ownershipEpoch: string;
      ownerClientId: string;
      ownerTitle: string;
      isOwner: boolean;
      sourceColumns: number;
      sourceRows: number;
      sourceRevision: string;
      viewColumns: number;
      viewRows: number;
    }
  | { type: "exited"; status: number }
  | { type: "detached" }
  | { type: "error"; message: string };

/**
 * One frame of `GET /api/terminals/stream`, the single stream carrying every open terminal.
 *
 * One stream rather than one per terminal because a browser on HTTP/1.1 holds about six
 * connections per origin and an EventSource holds one for as long as it lives, so a wall of
 * terminals would open its first six and leave the rest, and the panel's other requests, waiting
 * on a connection that never frees.
 */
export interface AgentTerminalStreamEnvelope {
  terminalId: string;
  message: AgentTerminalStreamMessage;
}

/**
 * `GET /api/terminals/{terminalId}/history` -- the scrollback the viewer was never sent.
 *
 * Base64, because it carries the escape sequences that colour it. Empty when the terminal has no
 * history behind it to hand over.
 */
export interface AgentTerminalHistory {
  data: string;
}

/** `POST /api/terminals/{terminalId}/input`. */
export interface AgentTerminalInput {
  data: string;
  encoding: "utf8" | "base64";
}

/** `POST /api/terminals/{terminalId}/viewport`. */
export interface AgentTerminalViewport {
  sequence: string;
  active: boolean;
  /**
   * Whether this viewer's box should become the pane's shape.
   *
   * A tmux window has ONE size for everyone, so a viewer that claims it reshapes the session in
   * whatever terminal its owner has it open in, and for the agent running there that is a reflow
   * of its whole screen. A surface big enough to be somewhere you work claims; a surface that is a
   * glance at a session living elsewhere does not, and scales its own type to fit instead.
   *
   * Measured 2026-09-08, which is why this is a field rather than an assumption: the composer's
   * terminal band on a canvas card claimed, and left two live sessions pinned at 48x9 and 56x16 --
   * small enough that Claude's TUI redrew its entire frame continuously, and still that size after
   * the band was closed.
   *
   * `columns` and `rows` are reported either way: the reply carries the pane's real shape and
   * whether it matches, which is what a follower scales against.
   */
  claim: boolean;
  columns: number;
  rows: number;
}

/** `POST /api/terminals/{terminalId}/close`. */
export interface CloseAgentTerminalRequest {
  mode: "detach" | "kill";
}
