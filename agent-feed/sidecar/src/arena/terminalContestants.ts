// Driving a contestant as an ordinary interactive session in a tmux pane: the terminals mode.
//
// Nothing here is new machinery. The pane is started, stamped and named the way every session the
// panel starts is (`startClaudeSession`, `adoptTitleName`), so the lane's terminal, a canvas card
// and `tmux attach` all land on the same pane. Claude is ready when its composer is drawn
// (`awaitComposer`), and the prompt is typed into that composer the way the panel's own composer
// types (`syncTmuxComposer`, then Enter). Opencode's prompt goes through the serve exactly as it
// does headless; its pane is the TUI attached to that session, for the reader to watch and type
// into, and the serve does not need it to take the turn.
//
// What the arena adds is only the order: pane, ready, wait at the run's start line, prompt, turn
// close. The facts are read the same way the headless drivers read them, so a run's facts mean
// the same thing whichever mode drove it.
//
// The confinement is the headless one, unchanged: Claude runs the same argv minus `--print`, and
// the opencode session is created holding the same rules before any pane exists.

import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContestantPlan, ContestantResult, ContestantTerminal } from "@/arena/contestantDriver";
import {
  ClaudeContestantError,
  claudeContestantArgv,
  factsFromClaudeTranscript,
  readClaudeTranscript,
} from "@/arena/claudeContestant";
import {
  driveOpencodeTurn,
  openOpencodeContestant,
  OpencodeContestantError,
  type OpencodeContestantBackend,
  type OpencodeContestantOptions,
} from "@/arena/opencodeContestant";
import { claudeBinary } from "@/config/configBinaries";
import { awaitComposer, submitTmuxComposer, syncTmuxComposer } from "@/input/tmuxComposer";
import { opencodeSessionPaneName } from "@/terminal/agentTerminalIdentity";
import { startClaudeSession, UNATTENDED_COLUMNS, UNATTENDED_ROWS } from "@/terminal/claudeSessionLaunch";
import { adoptTitleName } from "@/terminal/tmux/tmuxRelabel";
import { createTmuxSession, waitForPaneToSettle } from "@/terminal/tmux/tmuxSessions";
import { onTranscriptWrite } from "@/transcripts/catalog/transcriptWrites";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";

/**
 * How long an opencode TUI gets to draw and go quiet before the run stops waiting for it.
 *
 * A look, not a gate: the serve takes the prompt whether the TUI has drawn or not, so a TUI that
 * never settles -- one animating something -- costs the reader a moment of watching a pane load,
 * never the contestant's turn.
 */
const OPENCODE_SETTLE_LIMIT_MS = 15_000;

/** The tmux acts the two drivers take, injectable so the order can be tested without tmux. */
export interface TerminalContestantSteps {
  /** Starts a confined Claude session in its pane and answers the pane's name. */
  startClaude(options: { cwd: string; sessionId: string; title: string; command: string[] }): Promise<string>;
  /** Starts the TUI on an opencode session that already exists and answers the pane's name. */
  startOpencode(options: { cwd: string; sessionId: string; title: string }): Promise<string>;
  /** True once the session's composer is drawn, false when it is not within the limit. */
  awaitComposer(sessionId: string, limitMs: number): Promise<boolean>;
  /** Waits for a pane to draw and go quiet, or for the limit, whichever is first. */
  settlePane(pane: string, limitMs: number): Promise<void>;
  /** Types the prompt into the session's composer and presses Enter; throws when it could not. */
  typePrompt(sessionId: string, prompt: string): Promise<void>;
  /** Calls `onWrite` whenever the session's transcript is written; answers the unsubscribe. */
  watchTranscript(sessionId: string, onWrite: () => void): () => void;
  /** The session's transcript as it stands; throws while there is none. */
  readTranscript(sessionId: string): Promise<string>;
}

export const LIVE_TERMINAL_STEPS: TerminalContestantSteps = {
  startClaude: async (options) => (await startClaudeSession(options)).tmuxSession,
  startOpencode: async ({ cwd, sessionId, title }) => {
    const pane = opencodeSessionPaneName(sessionId);
    // Plain `opencode`, resolved through the login shell the pane runs in, as the session's own
    // terminal starts it. It attaches to this machine's serve rather than starting one of its own.
    await createTmuxSession({
      session: pane,
      cwd,
      command: ["opencode", "--session", sessionId],
      columns: UNATTENDED_COLUMNS,
      rows: UNATTENDED_ROWS,
    });
    return adoptTitleName(pane, sessionId, title);
  },
  awaitComposer: (sessionId, limitMs) => awaitComposer(sessionId, limitMs),
  settlePane: async (pane, limitMs) => {
    await waitForPaneToSettle(pane, { timeoutMs: limitMs });
  },
  typePrompt: async (sessionId, prompt) => {
    const typed = await syncTmuxComposer(sessionId, prompt);
    if (typed.reason !== null) throw new ClaudeContestantError(`could not type the prompt: ${typed.reason}`);
    const sent = await submitTmuxComposer(sessionId);
    if (sent.reason !== null) throw new ClaudeContestantError(`could not send the prompt: ${sent.reason}`);
  },
  watchTranscript: (sessionId, onWrite) => {
    const file = `${sessionId}.jsonl`;
    return onTranscriptWrite((path) => {
      if (basename(path) === file) onWrite();
    });
  },
  readTranscript: readClaudeTranscript,
};

/** The terminal hooks a terminals-mode plan carries; their absence is the run's bug, not the harness's. */
function terminalOf(plan: ContestantPlan): ContestantTerminal {
  if (!plan.terminal) throw new Error("a terminals-mode driver was handed a plan with no terminal");
  return plan.terminal;
}

/**
 * Whether the transcript's latest turn has closed: a turn was opened (a user record) and the last
 * record that says anything about turn state says it closed (`end_turn`). The same rule the catalog
 * reads a session's liveness by, through the same adapter.
 */
export function claudeTurnClosed(text: string): boolean {
  let opened = false;
  let closed = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const turnClosed = claudeAdapter.processLine(line)?.turnClosed;
    if (turnClosed === undefined) continue;
    if (!turnClosed) opened = true;
    closed = turnClosed;
  }
  return opened && closed;
}

/**
 * Drives one Claude contestant in a pane and resolves when the prompted turn has closed.
 *
 * Ready is the composer being drawn, which also covers a reader answering a startup question in
 * the pane (the folder-trust one): until they do, there is no composer, and the contestant waits
 * at `starting` for as long as a turn may run.
 */
export async function runClaudeTerminalContestant(
  plan: ContestantPlan,
  options: {
    model?: string | null;
    effort?: string | null;
    /** Overrides the binary lookup; null is "not installed", as the lookup answers it. */
    binary?: string | null;
    newSessionId?: () => string;
    steps?: TerminalContestantSteps;
  } = {},
): Promise<ContestantResult> {
  const terminal = terminalOf(plan);
  const steps = options.steps ?? LIVE_TERMINAL_STEPS;
  const binary = options.binary !== undefined ? options.binary : claudeBinary();
  if (!binary) {
    throw new ClaudeContestantError(
      "no claude CLI on this machine: install it, or set AGENT_FEED_CLAUDE_PATH",
    );
  }
  const sessionId = options.newSessionId?.() ?? randomUUID();
  const command = claudeContestantArgv({
    binary,
    sessionId,
    model: options.model,
    effort: options.effort,
    interactive: { name: terminal.label },
  });
  const pane = await steps.startClaude({ cwd: plan.worktreePath, sessionId, title: terminal.label, command });
  terminal.onPane(pane, sessionId);

  if (!await steps.awaitComposer(sessionId, plan.turnTimeoutMs)) {
    throw new ClaudeContestantError(
      `its composer never appeared within ${plan.turnTimeoutMs}ms; the pane is still open to read why`,
    );
  }
  await terminal.ready();

  // Listening before typing, so a turn that closes fast cannot close unheard. Every write re-reads
  // the whole transcript: one contestant's one turn is small, and a read that tried to follow
  // offsets would be a second copy of what the catalog's follow already does.
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const check = async (): Promise<void> => {
    const text = await steps.readTranscript(sessionId).catch(() => null);
    if (text !== null && claudeTurnClosed(text)) resolveClosed();
  };
  const stop = steps.watchTranscript(sessionId, () => void check());
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await steps.typePrompt(sessionId, plan.prompt);
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), plan.turnTimeoutMs);
      timer.unref?.();
    });
    void check();
    if (await Promise.race([closed, timedOut]) === "timeout") {
      throw new ClaudeContestantError(`contestant did not close its turn within ${plan.turnTimeoutMs}ms`);
    }
  } finally {
    if (timer) clearTimeout(timer);
    stop();
  }

  const { events, usage } = factsFromClaudeTranscript(await steps.readTranscript(sessionId));
  return { sessionId, events, usage };
}

/**
 * Drives one opencode contestant with its TUI in a pane, and resolves when its turn has closed.
 *
 * The session is made and confined first, exactly as headless, so no pane ever shows a session
 * without its rules. The prompt then goes through the serve, which is what closes the turn and
 * reports its outcome; the TUI shows it arriving like any message.
 */
export async function runOpencodeTerminalContestant(
  backend: OpencodeContestantBackend,
  plan: ContestantPlan,
  options: OpencodeContestantOptions & { steps?: TerminalContestantSteps } = {},
): Promise<ContestantResult> {
  const terminal = terminalOf(plan);
  const steps = options.steps ?? LIVE_TERMINAL_STEPS;
  const sessionId = await openOpencodeContestant(backend, plan, options);
  let pane: string;
  try {
    pane = await steps.startOpencode({ cwd: plan.worktreePath, sessionId, title: terminal.label });
  } catch (error) {
    throw new OpencodeContestantError(`its pane could not be started: ${String(error)}`);
  }
  terminal.onPane(pane, sessionId);
  await steps.settlePane(pane, OPENCODE_SETTLE_LIMIT_MS);
  await terminal.ready();
  return driveOpencodeTurn(backend, sessionId, plan, options);
}
