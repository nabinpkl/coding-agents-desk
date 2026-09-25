// This machine's opencode sessions, read off its serve rather than discovered
// on disk.
//
// Registered and reconciled rather than watched: there is no file whose
// arrival means a session, only the serve's list. A runaway serve that lists
// ten thousand sessions costs one HTTP round trip per reconcile, which is why
// the interval is the backstop and the serve's own event stream is the trigger.

import type { OpencodeClient, SessionV2Info } from "@opencode-ai/sdk/v2/client";
import { config } from "@/config/config";
import { describeServeError, opencodeClient, resetOpencodeClient } from "@/agents/opencode/opencodeClient";
import type { OpencodeSessionLocation } from "@/agents/opencode/opencodeAgentBackend";
import type { Session } from "@/transcripts/transcriptTypes";
import { state } from "@/transcripts/transcriptState";
import { broadcast, findSession, scheduleBroadcast, sessionKey } from "@/transcripts/catalog/catalogState";
import { canonicalDirectory, makeSession } from "@/transcripts/catalog/catalogRecords";

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleOpencodeReconcile(): void {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileOpencode()
      .then(broadcast)
      .catch((error) => console.error("agent feed opencode catalog reconcile failed", error));
  }, 1000);
  reconcileTimer.unref?.();
}

export function stopOpencodeReconcile(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
}

export async function reconcileOpencode(client: OpencodeClient | null = opencodeClient()): Promise<void> {
  const startedAt = performance.now();
  if (!client) {
    // Loud in the log, empty for the source, alive for the rest: the same
    // contract `reconcileSource` keeps for an unreadable transcript store.
    console.error(JSON.stringify({
      event: "agent-feed-catalog-source-failed",
      source: "opencode",
      message: "opencode serve password is not configured",
    }));
    return;
  }
  let sessions: SessionV2Info[];
  try {
    const response = await client.v2.session.list();
    if (response.error) throw new Error(`list: ${describeServeError(response.error)}`);
    sessions = response.data?.data ?? [];
  } catch (error) {
    if (error instanceof Error && /401|unauthorized/i.test(error.message)) resetOpencodeClient();
    throw error;
  }
  const next = new Map<string, Session>();
  for (const session of sessions) {
    const record = await toRecord(session);
    if (record) next.set(sessionKey("opencode", session.id), record);
  }
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "opencode" && !next.has(key)) state.sessions.delete(key);
  }
  for (const [key, session] of next) state.sessions.set(key, session);
  console.log(JSON.stringify({
    event: "agent-feed-catalog-source-ready",
    source: "opencode",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sessions: next.size,
  }));
}

async function toRecord(session: SessionV2Info): Promise<Session | null> {
  // Canonicalised, because the catalog compares by identity: the serve reports
  // the directory as opened, which may spell a symlink differently than the
  // paths Claude records carry for the same checkout.
  const project = (await canonicalDirectory(session.location.directory).catch(() => null))
    ?? session.location.directory;
  return makeSession("opencode", session.id, project, undefined, session.time.updated, {
    title: session.title || undefined,
  });
}

export function registerOpencodeSession(location: OpencodeSessionLocation): void {
  state.sessions.set(sessionKey("opencode", location.sessionId), makeSession(
    "opencode",
    location.sessionId,
    location.projectPath,
    undefined,
    Date.now(),
  ));
  broadcast();
}

export function resolveOpencodeSession(sessionId: string): OpencodeSessionLocation | undefined {
  const session = findSession("opencode", sessionId);
  return session ? { sessionId, projectPath: session.project } : undefined;
}

/**
 * Restamps one session's recency at the moment the serve said it moved.
 *
 * The record carries no turn state -- listing never opens a thread -- so a
 * session is never shown live on this stamp alone. Liveness comes from the
 * backend's descriptor, which is watching the thread; this stamp only keeps
 * the row's age honest between reconciles.
 */
export function notifyOpencodeSessionChanged(sessionId: string): void {
  const key = sessionKey("opencode", sessionId);
  const session = state.sessions.get(key);
  if (!session) return;
  session.lastEventAt = Math.max(session.lastEventAt, Date.now());
  scheduleBroadcast();
}

export function opencodeReconcileMs(): number {
  return config.opencodeReconcileMs;
}
