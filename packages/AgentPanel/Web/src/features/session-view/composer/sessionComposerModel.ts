// What the composer's parts read: the session, the bands it might be showing, the hooks
// behind each of them, and the draft.
//
// One object rather than twenty parameters, because every part below reads a different
// six of these and the six overlap. Built once per render in `SessionComposer.tsx`, which
// is the only thing that decides any of it.

import type { AgentSessionControlState } from "@/features/activity-feed/data-source/AgentDataSource";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { useTmuxComposer } from "@/features/cli-input/useTmuxComposer";
import type { SdkSessionHandle } from "@/features/cli-input/useSdkSession";
import type { RunModeSwitchHandle } from "@/features/cli-input/useRunModeSwitch";
import type { ClaudeRunMode } from "@agentdesk/agent-feed-wire";
import type { useSendAttachments, SendAttachment } from "@/features/session-view/composer/hold/useComposerHold";
import type { OpencodeSlashCommand } from "@/features/session-view/composer/useOpencodeCommands";
import type { useWindowComposer } from "@/features/session-view/composer/useWindowComposer";
import type { AgentTerminalComposer } from "@/features/session-view/sessionTerminalTypes";
import type { DictationTarget } from "@/features/session-view/composer/dictationTarget";

/** Which surface owns composition for this session, and what it needs to write. */
export type ComposerTransport =
  /** A session run through the Agent SDK, typed into through its runner (ADR-0143). */
  | { kind: "sdk-session" }
  | { kind: "window" }
  | { kind: "tmux-composer" }
  /** A terminal CLI session whose tmux pane is not mirrored (yet, or at all). Sends nothing. */
  | { kind: "cli-session" }
  | { kind: "agent-terminal"; terminal: AgentTerminalComposer }
  | { kind: "agent-session" };

/**
 * Which surface owns composition. One explicit state, not several independent availability flags.
 *
 * An SDK session's runner owns it before anything else, because nothing else can reach that
 * session: its pane shows the runner's log, so a mirror would type into the wrong program, and it
 * has no window.
 *
 * Then a live tmux pane, ahead of the native window it may also be visible in. That ordering is
 * deliberate: where both exist, the pane is where the CLI actually is and the window is a Remote
 * Control view OF that pane, so writing the window's accessibility field is one indirection further
 * from the process than typing at its keyboard. It is also the only one of the two that is two-way.
 *
 * A native window owns it next, for a session that has no pane. A terminal CLI session whose pane
 * is not mirrored yet gets a band that sends nothing and hands its draft to the mirror when that
 * attaches; an already-open Agent Feed pty takes it instead, as it takes a KNOWN native refusal.
 * Opening a process remains an explicit action in the terminal control. (A turn put into the
 * session's messaging socket used to sit here, and was removed 2026-10-16: see `wire/cliSession.ts`.)
 */
export function composerTransport(options: {
  sdkCandidate: boolean;
  mirrored: boolean;
  terminalCandidate: boolean;
  windowCandidate: boolean;
  windowRefused: boolean;
  agentTerminal: AgentTerminalComposer | null;
}): ComposerTransport {
  const { sdkCandidate, mirrored, terminalCandidate, windowCandidate, windowRefused, agentTerminal } = options;
  if (sdkCandidate) return { kind: "sdk-session" };
  if (mirrored) return { kind: "tmux-composer" };
  if (terminalCandidate)
    return agentTerminal ? { kind: "agent-terminal", terminal: agentTerminal } : { kind: "cli-session" };
  if (windowCandidate) {
    return windowRefused && agentTerminal ? { kind: "agent-terminal", terminal: agentTerminal } : { kind: "window" };
  }
  return { kind: "agent-session" };
}

export interface ComposerModel {
  agentTerminalBand: boolean;
  capabilities: SessionSummary["capabilities"];
  deliveryError: string | null;
  deliveryPending: boolean;
  /**
   * Whether the phone's dictation streams into this composer, and the way to choose it; null for a
   * session it cannot reach, which is any but a Claude session in a terminal.
   */
  dictation: DictationTarget | null;
  editorValue: string;
  /** Attaches the pane's composer stream, which reaching for the field does too. */
  engage: () => void;
  /** The session's own error, from the agent control state. */
  error: string | null;
  /**
   * Takes images for this session's composer, or null where there is nowhere to put one: not a
   * Claude session, or one whose pane has been looked for and not found. The same function the
   * card's drop target is given, so the paperclip and a drop do the same thing.
   */
  acceptFiles: ((files: readonly File[]) => void) | null;
  /**
   * The id of the band's hidden file input, which the paperclip opens. An id rather than a ref,
   * because the actions are built while rendering and a ref is not something render may read.
   */
  filePickerId: string;
  cliSessionBand: boolean;
  isClaude: boolean;
  isCodex: boolean;
  localDraft: string;
  onAbort: () => void | Promise<void>;
  onSendMessage: (text: string, delivery: "next" | "steer", files?: SendAttachment[]) => Promise<void>;
  /**
   * Runs one parsed slash command, wherever it belongs: the sidecar for most, the panel for
   * `/model`, `/new`, `/fork`, `/export` and `/btw`. One door on purpose -- the composer parses
   * a name and arguments and does not learn which of them it owns.
   */
  onRunSlash: (name: string, args: string) => Promise<void>;
  /** What an opencode session offers after a slash; empty on every other source. */
  opencodeCommands: readonly OpencodeSlashCommand[];
  /** The session's current model as `providerID/modelID`, or null while nothing has named one. */
  sessionModel: string | null;
  pending: boolean;
  queued: number;
  running: boolean;
  /** Images held for the next send where nothing else holds them: opencode, and an SDK session. */
  sendAttachments: ReturnType<typeof useSendAttachments>;
  session: SessionSummary;
  setDeliveryError: (message: string | null) => void;
  setDeliveryPending: (pending: boolean) => void;
  /**
   * Writes the composer's own text, in memory and in storage together. Takes the updater form a
   * `useState` setter does, because the transport handover needs to keep whichever side already
   * holds a sentence.
   */
  setLocalDraft: (value: string | ((current: string) => string)) => void;
  state: AgentSessionControlState;
  tmuxBand: boolean;
  tmuxComposer: ReturnType<typeof useTmuxComposer>;
  /** The composer is an SDK session's runner (ADR-0143). */
  sdkBand: boolean;
  /** That runner's state and commands; inert for every other session. */
  sdkSession: SdkSessionHandle;
  /** How the session runs now, when it is one of the two modes a switch moves between (ADR-0143). */
  runMode: ClaudeRunMode | null;
  runModeSwitch: RunModeSwitchHandle;
  /** Live processes holding the session. More than one forks its transcript. */
  liveProcesses: number;
  transport: ComposerTransport;
  unavailable: boolean;
  windowBand: boolean;
  windowComposer: ReturnType<typeof useWindowComposer>;
}
