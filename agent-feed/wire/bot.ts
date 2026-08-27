// The curated Bot roster. A Bot owns one existing project directory first;
// provider sessions from that directory can then be attached to its projection.

import type { SourceId } from "./activity.ts";
import type { SessionSummary } from "./session.ts";

export type BotGrant = "add_bot";

export interface BotSessionRef {
  source: SourceId;
  sessionId: string;
}

export interface BotDirectoryEnvironment {
  kind: "directory";
  path: string;
}

export interface BotMetadata {
  role?: string;
  description?: string;
  labels: string[];
  custom: Record<string, string>;
}

export type BotCreatedBy =
  | { kind: "user" }
  | { kind: "bot"; botId: string };

export interface BotRecord {
  botId: string;
  name: string;
  /** An https image URL. The panel renders initials when absent or unavailable. */
  iconUrl?: string;
  environment: BotDirectoryEnvironment;
  sessionRefs: BotSessionRef[];
  metadata: BotMetadata;
  grants: BotGrant[];
  createdAt: number;
  createdBy: BotCreatedBy;
}

export interface BotView extends BotRecord {
  environmentAvailability: "available" | "missing";
  /** Current catalog summaries for the attached references that still resolve. */
  sessions: SessionSummary[];
  /** Durable references retained when their catalog session is no longer available. */
  missingSessionRefs: BotSessionRef[];
}

export interface BotSnapshot {
  version: 2;
  revision: number;
  bots: BotView[];
}

export interface AddBotCommand {
  requestId: string;
  name: string;
  iconUrl?: string;
  /** Must exactly name an existing AgentDesk project directory. */
  directoryPath: string;
  metadata?: {
    role?: string;
    description?: string;
    labels?: string[];
    custom?: Record<string, string>;
  };
  /** Only the authenticated user API may grant management capabilities. */
  grants?: BotGrant[];
}

export interface AttachBotSessionsCommand {
  requestId: string;
  sessionRefs: BotSessionRef[];
}

/**
 * Removes references from a Bot's projection. The sessions themselves are untouched: a Bot is a
 * curated view over transcripts it does not own, so detaching is forgetting, not deleting.
 *
 * Same fields as attaching, and deliberately not the same type. Attaching resolves every reference
 * against the live catalog, because a Bot may only claim sessions from its own directory; detaching
 * must NOT, or a session that has gone missing would be the one thing that can never be removed --
 * and those are exactly the ones a viewer wants gone.
 */
export interface DetachBotSessionsCommand {
  requestId: string;
  sessionRefs: BotSessionRef[];
}
