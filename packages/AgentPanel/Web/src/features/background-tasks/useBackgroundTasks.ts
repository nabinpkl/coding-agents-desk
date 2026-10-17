import { useEffect, useState } from "react";
import type { BackgroundTaskSnapshot } from "@agentdesk/agent-feed-wire";
import type { AgentDataSource, SessionReference } from "@/features/activity-feed/data-source/AgentDataSource";

const EMPTY: BackgroundTaskSnapshot = { running: [], finished: [], ownerAlive: false, ownerWaiting: false };

/**
 * The selected session's background tasks.
 *
 * One subscription, held while a session is open. The sidecar only sends on change, so a session
 * sitting on a single long task is quiet on the wire -- which matters, because this stream runs to
 * a phone over a tailnet.
 */
export function useBackgroundTasks(
  source: AgentDataSource,
  session: SessionReference | null,
): BackgroundTaskSnapshot {
  const [snapshot, setSnapshot] = useState<BackgroundTaskSnapshot>(EMPTY);
  const sessionId = session?.sessionId ?? null;
  const sessionSource = session?.source ?? null;

  useEffect(() => {
    if (!session || !sessionId || !sessionSource) {
      setSnapshot(EMPTY);
      return;
    }
    // Clear on switch rather than carrying the previous session's tasks into this one's chip.
    setSnapshot(EMPTY);
    return source.subscribeBackgroundTasks(session, {
      onSnapshot: setSnapshot,
      // A stream that dropped tells us nothing new, and showing the last known list forever
      // would be worse than showing none: the count would be a claim we can no longer support.
      onError: () => setSnapshot(EMPTY),
    });
    // Keyed by identity, not by object: the session reference is rebuilt on every render of the
    // shell, and depending on it directly would tear the stream down twice a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sessionId, sessionSource]);

  return snapshot;
}

/**
 * Elapsed time, re-derived on the client.
 *
 * The server deliberately leaves elapsed out of its change-detection, because a clock that ticked
 * on the wire would mean a message every poll and defeat the suppression. So the value that ships
 * is `startedAt`, and the ticking happens here.
 */
export function useElapsedNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
