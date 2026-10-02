// What the session view knows about the terminal band beneath it.
//
// Shared by the view and its composer: the composer decides whether the field or the
// terminal is the band's input surface, and the view decides how tall the band is.

import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  SessionSummary,
  SessionTmuxTerminalContext,
} from "@agentdesk/agent-feed-wire";
import type { AgentTerminalState } from "@/features/terminal/useAgentTerminal";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import type { WindowComposerClient } from "@/features/window-composer/WindowComposerClient";
import type { OpenAskUserQuestion } from "@/app/askUserQuestion";

export type TerminalState =
  | { kind: "idle" }
  | { kind: "loading"; context: AgentTerminalContext }
  | { kind: "ready"; context: AgentTerminalContext; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; context: AgentTerminalContext; code: string }
  | { kind: "ended"; context: AgentTerminalContext; exitStatus?: number };

export interface AgentTerminalComposer {
  send: (text: string) => Promise<void>;
}

/**
 * Everything a `SessionView` needs that is not the session itself.
 *
 * One object because it is identical for every session on a surface: a Bot canvas hands the same
 * one to whichever row it has open, and the shell builds all of it once. Split out so a surface
 * that renders sessions can take "the context" as a single prop instead of restating nine.
 */
export interface SessionViewContext {
  feed: SidecarDataSource;
  host: HostActionsClient;
  /**
   * Raw or nice, and the toggle for it. Owned by whoever mounts this rather than in here, because
   * it is a reader's preference that outlives any one session and is persisted as such.
   */
  eventMode: EventMode;
  onToggleEventMode: () => void;
  showCacheHits: boolean;
  onToggleCacheHits: () => void;
  /**
   * One client per source, built by the owner. They are bound to a source rather than a session --
   * Claude resolves its window by process tree, Codex by its accessibility tree -- so they are
   * shared across every session rather than rebuilt per view.
   */
  windowComposers: { claude: WindowComposerClient; codex: WindowComposerClient };
  /** Whether the tasks panel should present as a sheet rather than a column beside the thread. */
  compact: boolean;
  /**
   * Where the background-tasks panel renders, or null to render it in place.
   *
   * It is the one thing here that is not part of the column: it floats over the thread, positioned
   * against the app's own relative root. A host keeps that true without this component having to
   * know what it is layered over.
   */
  tasksHost: HTMLElement | null;
  /**
   * Branches a session from one of its messages, or absent on a surface with nowhere to put a fork.
   *
   * Carries the session and its directory as well as the message, because the surface that acts on
   * it holds none of the three: a canvas has several sessions open at once, the row that asked is
   * inside whichever one the reader was reading, and the fork's proposed name is numbered against
   * the titles already in that directory.
   */
  onForkFromMessage?: (request: {
    session: SessionSummary;
    projectPath: string;
    message: { eventId: string; text: string };
    /** The Bot whose card asked, which the fork then lands on as a card. Absent off the canvas. */
    botId?: string;
  }) => void;
}
