import { useState } from "react";
import type { BackgroundTaskSnapshot } from "@agentdesk/agent-feed-wire";
import type { AgentDataSource, SessionReference } from "@/features/activity-feed/data-source/AgentDataSource";
import { useInterval } from "@/hooks/useInterval";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

const EMPTY: BackgroundTaskSnapshot = { running: [], finished: [], ownerAlive: false, ownerWaiting: false };

/**
 * The selected session's background tasks.
 *
 * One subscription, held while a session is open. The sidecar only sends on change, so a session
 * sitting on a single long task is quiet on the wire -- which matters, because this stream runs to
 * a phone over a tailnet.
 */
export function useBackgroundTasks(source: AgentDataSource, session: SessionReference | null): BackgroundTaskSnapshot {
  const sessionId = session?.sessionId ?? null;
  const sessionSource = session?.source ?? null;
  // Keyed by identity, not by object: the session reference is rebuilt on every render of the
  // shell, and following the object would tear the stream down twice a second.
  const key = session && sessionId && sessionSource ? `${sourceKey(source)}:${sessionSource}:${sessionId}` : null;
  // Cleared on switch rather than carrying the previous session's tasks into this one's chip.
  const [snapshot, setSnapshot] = useStateFor<BackgroundTaskSnapshot>(key, () => EMPTY);

  useSubscription(key, () => {
    if (!session) return;
    return source.subscribeBackgroundTasks(session, {
      onSnapshot: setSnapshot,
      // A stream that dropped tells us nothing new, and showing the last known list forever
      // would be worse than showing none: the count would be a claim we can no longer support.
      onError: () => setSnapshot(EMPTY),
    });
  });

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
  useInterval(() => setNow(Date.now()), active ? intervalMs : null);
  return now;
}
