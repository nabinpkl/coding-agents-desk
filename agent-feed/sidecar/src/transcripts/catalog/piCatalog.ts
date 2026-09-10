// Pi's own sessions, which the sidecar hosts rather than observes.
//
// Registered rather than discovered: a Pi session exists because this process started it,
// so there is no file to watch for its arrival, only for its writes.

import { stat } from "node:fs/promises";
import { piLocation, scanPiSessions } from "@/agents/piSessionCatalog";
import { PI_AGENT_CAPABILITIES, type PiSessionLocation } from "@/agents/piAgentBackend";
import type { Session } from "@/transcripts/transcriptTypes";
import { state } from "@/transcripts/transcriptState";
import { broadcast, findSession, scheduleBroadcast, sessionKey } from "@/transcripts/catalog/catalogState";
import { makeSession } from "@/transcripts/catalog/catalogRecords";

export async function reconcilePi(): Promise<void> {
  const startedAt = performance.now();
  const sessions = await scanPiSessions();
  const next = new Map(sessions.map((session) => [sessionKey("pi", session.sessionId), session]));
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "pi" && !next.has(key)) state.sessions.delete(key);
  }
  for (const [key, session] of next) state.sessions.set(key, session);
  console.log(JSON.stringify({
    event: "agent-feed-catalog-source-ready",
    source: "pi",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sessions: next.size,
  }));
}

export function registerPiSession(location: PiSessionLocation): void {
  state.sessions.set(sessionKey("pi", location.sessionId), {
    sessionId: location.sessionId,
    source: "pi",
    project: location.projectPath,
    transcriptPath: location.transcriptPath,
    title: location.title,
    lastEventAt: location.lastEventAt,
    entrypoint: "pi",
  });
  broadcast();
}

export function notifyPiSessionChanged(sessionId: string): void {
  const key = sessionKey("pi", sessionId);
  const session = state.sessions.get(key);
  if (!session) return;
  // Restamped here, at the one moment the change is known, rather than left for every
  // consumer to re-derive with a `stat` of its own each time it renders the session.
  // Pi's own watcher rescans on a timer, so this is what keeps the record honest in
  // between: an agent event moves the file before that rescan runs.
  void stat(session.transcriptPath)
    .then((metadata) => {
      const current = state.sessions.get(key);
      if (current) current.lastEventAt = Math.max(current.lastEventAt, metadata.mtimeMs);
    })
    .catch((error) => console.warn("agent feed Pi session metadata probe failed", error))
    .finally(() => scheduleBroadcast());
}

export function resolvePiSession(sessionId: string): PiSessionLocation | undefined {
  const session = findSession("pi", sessionId);
  return session ? piLocation(session) : undefined;
}
