// What the catalog holds, who is listening, and when they are told.
//
// The state itself lives in `transcriptState.ts`; this is the reading surface over it
// plus the coalesced broadcast, which every source's reconciliation calls once it has
// finished changing `state.sessions`.

import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type {
  AgentSessionCapabilities,
  AgentSessionDescriptor,
} from "@/agents/agentBackend";
import { state, type WatcherState } from "@/transcripts/transcriptState";
import type { Session, SourceId } from "@/transcripts/sources/transcriptTypes";

/**
 * The longest a title stays as written. Past this a row shows an ellipsis instead of the tail, so
 * it is also the longest a rename can usefully be: a longer one would be stored and then not said.
 */
export const SUMMARY_TITLE_CHARACTERS = 240;
/**
 * How much of an opening prompt is allowed to stand in for a title.
 *
 * Shorter than a title's own cap because it is not one: a prompt can be a wall of
 * pasted text, and a row that renders four lines of it is worse than the fallback
 * it replaced.
 */
export const PROMPT_TITLE_CHARACTERS = 120;

/**
 * How far back a Codex rollout is read to learn whether its last turn is open.
 *
 * Only ever asked for inside the live window, so this is a handful of files, not
 * the project.
 */
export const CODEX_TAIL_BYTES = 32 * 1024;

export const CLAUDE_SESSION_PATTERN = /^[0-9a-f-]{36}\.jsonl$/i;
export const ROLLOUT_PATTERN = /^rollout-[\d-]+T[\d-]+-([0-9a-f-]{36})\.jsonl$/i;

/**
 * How long a burst of transcript writes is allowed to accumulate before the catalog
 * tells anyone.
 *
 * Codex and Pi already coalesced; Claude did not, so a running agent broadcast once
 * per line written, and every subscriber recomputed its whole view each time.
 */
const BROADCAST_COALESCE_MS = 40;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

const TRANSCRIPT_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["raw", "nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: true,
  canOpenTerminal: true,
  supportsExtensionUi: false,
  canStreamLive: false,
};

export type AgentSessionDescriptorResolver = (
  source: SourceId,
  sessionId: string,
) => AgentSessionDescriptor | undefined;

export function sessionKey(source: SourceId, sessionId: string): string {
  return `${source}:${sessionId}`;
}

export function getWatcherState(): WatcherState {
  return state.watcherState;
}

export function getSnapshot(): Session[] {
  return [...state.sessions.values()].sort((left, right) =>
    right.lastEventAt - left.lastEventAt
  );
}

export function findSession(source: SourceId, sessionId: string): Session | undefined {
  return state.sessions.get(sessionKey(source, sessionId));
}

export function subscribeCatalog(listener: (sessions: Session[]) => void): () => void {
  state.subscribers.add(listener);
  return () => {
    state.subscribers.delete(listener);
  };
}

/**
 * Which version of the catalog the project list was computed against.
 *
 * The project list is a fold over every session the catalog holds, so it is the one
 * projection worth remembering between changes: N subscribers watching the same
 * catalog compute it once rather than once each. A project's session list is not
 * memoized -- it is a filter and a sort over records already in memory, and a cache
 * in front of that would cost more in invalidation rules than it saves.
 */
let catalogGeneration = 0;
let projectSummariesMemo: { generation: number; value: ProjectSummary[] } | null = null;

export function broadcast(): void {
  catalogGeneration += 1;
  projectSummariesMemo = null;
  const snapshot = getSnapshot();
  for (const listener of state.subscribers) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("agent feed catalog subscriber failed", error);
    }
  }
}

/**
 * Broadcasts once for a burst of changes.
 *
 * Used by the per-file paths, which fire as fast as an agent writes. The reconciles
 * have their own timers upstream of this and broadcast directly, because by the time
 * one runs the coalescing already happened.
 */
export function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, BROADCAST_COALESCE_MS);
}

/**
 * The memoized project list, or null when this generation has not computed one.
 *
 * Read and written from `catalogViews.ts`, which owns the fold; the memo lives here
 * because `broadcast` is what invalidates it, and both halves must agree on when.
 */
export function memoizedProjectSummaries(): ProjectSummary[] | null {
  return projectSummariesMemo?.generation === catalogGeneration ? projectSummariesMemo.value : null;
}

export function rememberProjectSummaries(value: ProjectSummary[]): void {
  projectSummariesMemo = { generation: catalogGeneration, value };
}

/** Drops the pending broadcast and the memo. Called from `stopCatalog`. */
export function resetCatalogBroadcast(): void {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  projectSummariesMemo = null;
}

export { TRANSCRIPT_CAPABILITIES };
