// What a terminal is pointed at, resolved once before anything is launched or joined.
//
// Four kinds of target arrive from the panel and they answer the same shape, which is what
// lets `open` stop caring which one it got. Everything that decides where a terminal lands --
// which pane, which directory, which command, whether a new one may be started at all -- is
// here; the service is what acts on the answer.
//
// Free functions over a `deps` record rather than methods, because the resolution reads three
// collaborators and writes nothing: what it needs is stated in the signature instead of being
// reachable through the whole service.

import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
  AgentSessionTerminalContext,
  AgentTerminalContext,
  NewTmuxTerminalContext,
  SessionTmuxTerminalContext,
  TmuxTerminalContext,
  WorkspaceTerminalContext,
} from "@agentdesk/agent-feed-wire";
import { claudeSessionPaneName } from "@/terminal/claudeSessionLaunch";
import { findTmuxSessionByIdentity } from "@/terminal/tmux/tmuxSessions";
import { currentProcessTable } from "@/tasks/processProbe";
import { liveSessionProcesses } from "@/tasks/sessionRegistry";
import {
  AgentTerminalConflictError,
  AgentTerminalInvalidError,
  AgentTerminalNotFoundError,
  requiredSessionUuid,
} from "@/terminal/agentTerminalErrors";

export interface ResolvedAgentTerminalSession {
  projectPath: string;
  activity: string;
  /** What the session is called, which is what a pane this path creates gets named after. */
  title: string;
}

/** Everything `open` needs that depends on what the terminal is pointed at. */
export interface TerminalIdentity {
  ptySessionName: string;
  /** Set for a tmux attach; the history and the mouse setting are that session's, not ours. */
  tmuxSession: string | null;
  cwd: string;
  /** Argv for the login shell to exec, command first. */
  command: string[];
  /** When set, a target with no PTY session yet must not get one, and this says why. */
  refuseNew: string | null;
  /**
   * When set, `tmuxSession` may be started rather than only joined, running this.
   *
   * Only kinds whose name cannot be a typo carry it. A tmux target named by the panel is
   * somebody else's session and creating it would answer a typo with a new process; a
   * session-backed one is a session id the sidecar resolved to a pane name itself, and a
   * `tmux-new` one is a name the panel offered past every standing session and refused to send
   * colliding, so a typo lands on a refused name or a fresh one rather than on a neighbour.
   */
  createTmux: { cwd: string; command: string[] } | null;
  /**
   * The title a pane created by this open should take, once its stamp reads back.
   *
   * Set only where this call is the one CREATING the pane. A pane that is merely joined belongs to
   * whoever started it, and renaming somebody else's session out from under them is not this
   * path's to do -- `renameSession.ts` is, where a person asked for it.
   */
  nameFromTitle?: string;
  /**
   * The session this terminal creates, when it creates one. Only the fork path does.
   *
   * Carried on the identity rather than computed at the descriptor, because the name is decided
   * where the command is built -- it IS an argument of that command -- and deriving it a second
   * time later could answer differently.
   */
  /**
   * The Claude session to stamp on the pane, so it can be found again after it is renamed.
   *
   * null for a raw tmux target: that pane is somebody else's, named by a human, and claiming it
   * for a session id would make this sidecar the answer to a question about a session it does not
   * run. Set for every session-backed kind, including a fork, where it is the FORK's id -- the
   * fork is the session that pane is running, and stamping its parent would put two panes on one
   * id and move a reader's terminal between them.
   */
  stampSession: string | null;
}

/** The three things resolving a target reads, and all it reads. */
export interface TerminalIdentityDeps {
  /** Every project directory must be inside this, and a tmux target's nominal cwd is it. */
  userHomeDirectory: string;
  resolveSession: (
    source: "claude" | "codex",
    sessionId: string,
  ) => ResolvedAgentTerminalSession | undefined;
  /** Which tmux session a live process for that session id is running inside; see `liveTmuxSession`. */
  tmuxOwner: (source: "claude" | "codex", sessionId: string) => Promise<string | null>;
}

/**
 * What to launch, where, and under which PTY session name.
 *
 * One place rather than a branch inside `open`, because the two kinds of terminal agree on
 * everything after this: the pty session is deterministic per target, so a second viewer of the
 * same target joins the running one instead of starting a second.
 */
export async function identifyTerminal(
  deps: TerminalIdentityDeps,
  context: AgentTerminalContext,
): Promise<TerminalIdentity> {
  if (context.kind === "tmux") return identifyTmux(deps, context);
  if (context.kind === "tmux-new") return identifyNewTmux(deps, context);
  if (context.kind === "session-tmux") return identifySessionTmux(deps, context);
  if (context.kind === "workspace") return identifyWorkspace(deps, context);
  return identifyAgentSession(deps, context);
}

/**
 * Attaching, not resuming: the process is already running and tmux is what allows a second
 * viewer.
 *
 * The name is validated here rather than at the tmux call, because every tmux verb takes it as
 * `-t <session>` on an argument vector this process builds -- so a name that is not a plain
 * identifier is refused once, at the door, instead of at each of five call sites.
 *
 * `command` is empty and `cwd` is nominal: nothing is launched on this path. They stay on the
 * shared identity shape because the PTY path needs them, and `ptySessionName` stays because the
 * descriptor carries it as the terminal's label on both backends.
 */
function identifyTmux(deps: TerminalIdentityDeps, context: TmuxTerminalContext): TerminalIdentity {
  const session = tmuxSessionName(context.session);
  return {
    ptySessionName: `agent-tmux-${session}`,
    tmuxSession: session,
    cwd: deps.userHomeDirectory,
    command: [],
    // A tmux session is meant to be watched from more than one place, so nothing to refuse.
    refuseNew: null,
    createTmux: null,
    stampSession: null,
  };
}

/**
 * A shell this open may start, in a directory rather than behind an agent.
 *
 * The name is validated here for the same reason a tmux target's is: both reach tmux as
 * `-t`/`-s` on an argument vector this process builds. The directory goes through
 * `projectDirectory`, the same check the workspace kind goes through, because the panel is a
 * browser tab and the check is what makes the request safe rather than the caller being well
 * behaved. An empty command is the login shell itself, resolved in `open`.
 */
async function identifyNewTmux(
  deps: TerminalIdentityDeps,
  context: NewTmuxTerminalContext,
): Promise<TerminalIdentity> {
  const session = tmuxSessionName(context.session);
  const cwd = await projectDirectory(deps, context.directory);
  return {
    ptySessionName: `agent-tmux-${session}`,
    tmuxSession: session,
    cwd,
    command: [],
    // Joining a session that is already running is the ordinary second-viewer case, so nothing
    // to refuse; the backend joins when it exists and starts it when it does not.
    refuseNew: null,
    createTmux: { cwd, command: [] },
    stampSession: null,
  };
}

/**
 * What tmux will accept as `-t <session>` on an argument vector this process builds.
 *
 * One check for both tmux kinds, because the danger is the same either way: a name that is not
 * a plain identifier is refused once, at the door, instead of at each call site.
 */
function tmuxSessionName(session: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(session)) {
    throw new AgentTerminalInvalidError("tmux session name is not a plain identifier");
  }
  return session;
}

/**
 * A shell in a workspace root, which is the one target with no agent behind it.
 *
 * Everything that stands between this and an arbitrary directory is `projectDirectory`, the same
 * check the agent-session kind goes through: absolute, existing, a directory, inside the home. The
 * IDE only ever sends a root it has registered, but the sidecar does not take the panel's word for
 * that -- the panel is a browser tab, and the check is what makes the request safe rather than the
 * caller being well behaved.
 */
async function identifyWorkspace(
  deps: TerminalIdentityDeps,
  context: WorkspaceTerminalContext,
): Promise<TerminalIdentity> {
  const root = await projectDirectory(deps, context.workspacePath);
  return {
    ptySessionName: workspaceSessionName(root),
    tmuxSession: null,
    cwd: root,
    // Empty is the login shell itself; `connectPtyTerminal` is what turns that into `zsh -l`.
    command: [],
    // A workspace shell is meant to be opened from more than one tab, and starting it is the
    // whole point of opening one, so there is nothing to refuse.
    refuseNew: null,
    createTmux: null,
    stampSession: null,
  };
}

/**
 * One PTY session name per workspace root, so the second tab to open a workspace joins the shell
 * the first one started rather than opening a second in the same directory.
 *
 * The last path component carries the name because that is what a reader recognises in the
 * descriptor, and the digest carries the identity: folding a path to name characters is not
 * injective -- `~/work/agent-desk` and `~/work-agent/desk` land on the same slug -- and two
 * workspaces sharing one shell would put a reader in the wrong directory with nothing on screen
 * to say so. The path is already canonical here, so two registrations of one directory through
 * different symlinks correctly share a shell.
 */
function workspaceSessionName(root: string): string {
  const leaf = (root.split("/").pop() || "root").replace(/[^A-Za-z0-9_.-]+/g, "-");
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `agent-workspace-${leaf}-${digest}`;
}

async function identifyAgentSession(
  deps: TerminalIdentityDeps,
  context: AgentSessionTerminalContext,
): Promise<TerminalIdentity> {
  if (context.source !== "claude" && context.source !== "codex") {
    throw new AgentTerminalInvalidError("terminal source must be claude or codex");
  }
  const sessionId = requiredSessionUuid(context.sessionId, "terminal session id");
  const projectPath = await projectDirectory(deps, context.projectPath);

  const session = deps.resolveSession(context.source, sessionId);
  if (!session) throw new AgentTerminalNotFoundError("agent session was not found");
  let catalogProject: string;
  try {
    catalogProject = await realpath(resolve(session.projectPath));
  } catch {
    throw new AgentTerminalConflictError("agent session project directory is no longer available");
  }
  if (catalogProject !== projectPath) {
    throw new AgentTerminalConflictError("agent session belongs to another project directory");
  }

  // A shell in the session's own directory, not a resumed agent.
  //
  // This used to launch `claude --resume <id>` (or `codex resume`), which made the terminal
  // control unusable exactly when it was most wanted: resuming a session that is already running
  // opens a second client to one transcript, so a LIVE session -- the common case -- was refused
  // and the pane never appeared at all. What the control is for is a terminal where that work is
  // happening; the running session is already watchable through its own tmux pane.
  //
  // `command` empty means the login shell itself, resolved in `open`.
  return {
    ptySessionName: `agent-shell-${context.source}-${sessionId}`,
    tmuxSession: null,
    cwd: projectPath,
    command: [],
    refuseNew: null,
    createTmux: null,
    stampSession: null,
  };
}

/**
 * A caller-supplied directory, resolved and vouched for, or a refusal naming what was wrong.
 *
 * Shared by the two kinds that are handed a path rather than resolving one from a session, which
 * is why it is here and not inlined in either: the checks are what stand between a terminal
 * request and an arbitrary directory on this machine, and two copies of them are two chances for
 * one to drift.
 */
async function projectDirectory(deps: TerminalIdentityDeps, path: string): Promise<string> {
  if (!path.startsWith("/")) {
    throw new AgentTerminalInvalidError("terminal project path must be absolute");
  }
  let projectPath: string;
  let homePath: string;
  try {
    [projectPath, homePath] = await Promise.all([
      realpath(resolve(path)),
      realpath(resolve(deps.userHomeDirectory)),
    ]);
    if (!(await stat(projectPath)).isDirectory()) {
      throw new AgentTerminalInvalidError("terminal project path must be a directory");
    }
  } catch (error) {
    if (error instanceof AgentTerminalInvalidError) throw error;
    throw new AgentTerminalInvalidError("terminal project directory does not exist");
  }
  const fromHome = relative(homePath, projectPath);
  if (!fromHome || fromHome.startsWith("..") || fromHome.startsWith("/")) {
    throw new AgentTerminalInvalidError("terminal project directory must be inside the user home");
  }
  return projectPath;
}

/**
 * The session's own tmux pane: the one it is running in, or one started to resume it.
 *
 * Which of the two it is cannot be decided by the caller. A panel asking "is this session in
 * tmux" gets null for a session running outside tmux and null again for one that is not running,
 * so it cannot tell a pane it should join from one it should start -- and by the time it acted on
 * either answer the session could have exited. Deciding it here also makes the pane name the
 * sidecar's: derived from the session id, so a second viewer of the same session lands on the
 * same pane instead of starting a second resume of one transcript.
 *
 * Resuming a session that is live SOMEWHERE ELSE -- a Claude Desktop window, say -- opens a
 * second client to one transcript. That is why the resume is the fallback rather than the first
 * move, and why the pane keeps a shell after the command exits: a CLI that refuses says so, and
 * the reason stays on screen.
 */
async function identifySessionTmux(
  deps: TerminalIdentityDeps,
  context: SessionTmuxTerminalContext,
): Promise<TerminalIdentity> {
  if (context.source !== "claude" && context.source !== "codex") {
    throw new AgentTerminalInvalidError("terminal source must be claude or codex");
  }
  const sessionId = requiredSessionUuid(context.sessionId, "terminal session id");
  const session = deps.resolveSession(context.source, sessionId);
  if (!session) throw new AgentTerminalNotFoundError("agent session was not found");
  let projectPath: string;
  try {
    projectPath = await realpath(resolve(session.projectPath));
  } catch {
    throw new AgentTerminalConflictError("agent session project directory is no longer available");
  }

  // The live process's own pane wins, and is joined rather than created: it is where the work is
  // actually happening, and it belongs to whoever started it.
  const owned = await deps.tmuxOwner(context.source, sessionId);
  if (owned) {
    return {
      ptySessionName: `agent-tmux-${owned}`,
      tmuxSession: owned,
      cwd: projectPath,
      command: [],
      refuseNew: null,
      createTmux: null,
        stampSession: sessionId,
    };
  }

  const pane = claudeSessionPaneName(sessionId);
  return {
    ptySessionName: `agent-tmux-${pane}`,
    tmuxSession: pane,
    cwd: projectPath,
    command: [],
    refuseNew: null,
    createTmux: {
      cwd: projectPath,
      command: context.source === "claude"
        ? ["claude", "--resume", sessionId]
        : ["codex", "resume", sessionId],
    },
    // Resuming, not creating: the session already exists and already has whatever name it has.
    stampSession: sessionId,
    // The pane, though, is this call's own, so it takes the session's title the way a freshly
    // started one does -- otherwise reopening a stopped session is the remaining way to get a
    // uuid-named pane on the list.
    nameFromTitle: session.title,
  };
}
/**
 * The tmux session a live process for that session id is running inside, if any.
 *
 * Claude only: its harness is what writes the process registry this reads, so a Codex session has
 * nothing to look up and answers "none" -- which lands it on the resume path, the same place a
 * Claude session that is not running lands.
 *
 * More than one row can claim one session id, and routinely does: a session resumed by the path
 * below registers itself under the same id as the session it resumed, so from the second open
 * onwards there are two panes to choose from. Measured on this machine with three rows for one id.
 * Somebody else's terminal wins, and the one this sidecar started is the fallback -- picking by
 * registry order would move a thread's terminal between two panes for no visible reason.
 */
export async function liveTmuxSession(
  source: "claude" | "codex",
  sessionId: string,
  processes: () => Promise<{ sessionId: string; tmuxSession: string | null }[]> =
    async () => liveSessionProcesses(await currentProcessTable()),
  stamped: (sessionId: string) => Promise<string | null> = findTmuxSessionByIdentity,
): Promise<string | null> {
  if (source !== "claude") return null;
  // The stamp first, because the registry's answer is a NAME the CLI resolved once at startup and
  // then cached. It never re-reads it, so a renamed session leaves that row pointing at a name
  // tmux no longer has -- measured: `has-session` on it exits 1 while the pane sits there running.
  // The stamp is set on the tmux session itself and rides through any number of renames.
  const byStamp = await stamped(sessionId).catch(() => null);
  if (byStamp) return byStamp;
  const panes = (await processes())
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.tmuxSession)
    .filter((pane): pane is string => pane !== null);
  // Still meaningful after panes started being renamed to their titles, though it reads as though
  // it should not be: a pane only gives up this name once its stamp reads back, so reaching here at
  // all -- the stamp having answered nothing -- means the sidecar's own pane is still called this.
  return panes.find((pane) => pane !== claudeSessionPaneName(sessionId)) ?? panes[0] ?? null;
}
