// What the composer's parts read: the session, the bands it might be showing, the hooks
// behind each of them, and the draft.
//
// One object rather than twenty parameters, because every part below reads a different
// six of these and the six overlap. Built once per render in `SessionComposer.tsx`, which
// is the only thing that decides any of it.

import type { RefObject } from "react";
import type { AgentSessionControlState } from "@/features/activity-feed/data-source/AgentDataSource";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { useTmuxComposer } from "@/features/cli-input/useTmuxComposer";
import type { useSendAttachments, SendAttachment } from "@/features/session-view/composer/useComposerHold";
import type { OpencodeSlashCommand } from "@/features/session-view/composer/useOpencodeCommands";
import type { useWindowComposer } from "@/features/session-view/composer/useWindowComposer";
import type { AgentTerminalComposer } from "@/features/session-view/sessionTerminalTypes";

/** Which surface owns composition for this session, and what it needs to write. */
export type ComposerTransport =
  | { kind: "window" }
  | { kind: "tmux-composer" }
  /** A terminal CLI session whose tmux pane is not mirrored (yet, or at all). Sends nothing. */
  | { kind: "cli-session" }
  | { kind: "agent-terminal"; terminal: AgentTerminalComposer }
  | { kind: "agent-session" };

export interface ComposerModel {
  agentTerminalBand: boolean;
  capabilities: SessionSummary["capabilities"];
  deliveryError: string | null;
  deliveryPending: boolean;
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
  filePicker: RefObject<HTMLInputElement | null>;
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
  /** Images held for an opencode send, which has no pane to hold them instead. */
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
  transport: ComposerTransport;
  unavailable: boolean;
  windowBand: boolean;
  windowComposer: ReturnType<typeof useWindowComposer>;
}
