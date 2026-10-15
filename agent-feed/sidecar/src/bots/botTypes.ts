// What a Bot registry talks about: who is asking, what the catalog can answer, what
// can go wrong, and what starting a session looks like from here.
//
// Separate from the registry so its command normalizer, its idempotency records and its
// session launcher can all name these without importing the class that uses them.

import type { BotSessionRef, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionLauncher } from "@/transcripts/session-ops/forkSession";

export type BotActor =
  | { kind: "user" }
  | { kind: "agent"; session: BotSessionRef };

export interface ResolvedBotSession {
  projectPath: string;
  summary: SessionSummary;
  /** The transcript on disk, which a fork from one of its messages counts back through. */
  transcriptPath?: string;
}

export interface BotRegistryCatalog {
  resolveProject(path: string): { projectPath: string } | undefined;
  resolveSession(ref: BotSessionRef): ResolvedBotSession | undefined;
  subscribe(listener: () => void): () => void;
  /** Settles once the catalog has read every source; until then a session it lacks is unread, not gone. */
  ready(): Promise<void>;
}

export class BotInvalidError extends Error {}
export class BotNotFoundError extends Error {}
export class BotConflictError extends Error {}
export class BotForbiddenError extends Error {}
/**
 * The Bot exists; its session does not.
 *
 * Its own class because it is the one failure here that leaves something behind. Every other
 * refusal happens before the record is written, so the caller can retry the identical command;
 * this one has already spent a name and a directory, and a retry would collide with the Bot it
 * just made. The message therefore names what to do with it rather than only what went wrong.
 */
export class BotLaunchError extends Error {}

/**
 * What actually starts a Bot's session, injected so the tests never spawn one.
 *
 * A seam rather than a direct call because the alternative is a test suite that either runs tmux
 * or does not exercise this path at all, and the second is how the ordering below stops being
 * checked.
 */
/**
 * How a Bot starts and ends a session, which is how ANY caller does.
 *
 * An alias rather than a second declaration of the same three methods. It kept its name because
 * the Bot's own vocabulary is what its callers read, and it stopped being its own shape when
 * forking became a session operation: two identical interfaces are two things to keep in step, and
 * the moment they drift the Bot is launching sessions a different way from everything else.
 */
export type BotSessionLauncher = SessionLauncher;
