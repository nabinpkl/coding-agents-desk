// What the composer's parts read: the session, the bands it might be showing, the hooks
// behind each of them, and the draft.
//
// One object rather than twenty parameters, because every part below reads a different
// six of these and the six overlap. Built once per render in `SessionComposer.tsx`, which
// is the only thing that decides any of it.

import type { RefObject } from "react";
import type { AgentSessionControlState } from "../activity-feed/data-source/AgentDataSource";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { CliInputHandle } from "../cli-input/useCliInput";
import type { useTmuxComposer } from "../cli-input/useTmuxComposer";
import type { useWindowComposer } from "./useWindowComposer";
import type { AgentTerminalComposer } from "./sessionTerminalTypes";

/** Which surface owns composition for this session, and what it needs to write. */
export type ComposerTransport =
  | { kind: "window" }
  | { kind: "tmux-composer" }
  | { kind: "cli-inbox" }
  | { kind: "agent-terminal"; terminal: AgentTerminalComposer }
  | { kind: "agent-session" };

export interface ComposerModel {
  agentTerminalBand: boolean;
  capabilities: SessionSummary["capabilities"];
  cliInput: CliInputHandle;
  deliveryError: string | null;
  deliveryPending: boolean;
  editorValue: string;
  /** The session's own error, from the agent control state. */
  error: string | null;
  filePicker: RefObject<HTMLInputElement | null>;
  inboxBand: boolean;
  isClaude: boolean;
  isCodex: boolean;
  localDraft: string;
  onAbort: () => void | Promise<void>;
  onSendMessage: (text: string, delivery: "next" | "steer") => Promise<void>;
  pending: boolean;
  queued: number;
  running: boolean;
  session: SessionSummary;
  setDeliveryError: (message: string | null) => void;
  setDeliveryPending: (pending: boolean) => void;
  setLocalDraft: (value: string) => void;
  state: AgentSessionControlState;
  tmuxBand: boolean;
  tmuxComposer: ReturnType<typeof useTmuxComposer>;
  transport: ComposerTransport;
  unavailable: boolean;
  windowBand: boolean;
  windowComposer: ReturnType<typeof useWindowComposer>;
}
