import { useEffect, useRef, useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 15_000);
}

/** One app-scoped subscription shared by every sidebar presentation. */
export function useBots(feed: SidecarDataSource): {
  bots: BotView[];
  loading: boolean;
  error: string | null;
} {
  const [bots, setBots] = useState<BotView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const consecutiveFailures = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = feed.subscribeBots(
      (snapshot) => {
        consecutiveFailures.current = 0;
        setBots(snapshot.bots);
        setLoading(false);
        setError(null);
      },
      (reason) => {
        setLoading(false);
        setError(reason);
        if (timer !== undefined) clearTimeout(timer);
        const delay = retryDelay(consecutiveFailures.current);
        consecutiveFailures.current += 1;
        timer = setTimeout(() => setRetry((attempt) => attempt + 1), delay);
      },
    );
    return () => {
      stop();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [feed, retry]);

  return { bots, loading, error };
}
