// What git says about a Bot's directory, as the sidecar sees it move.
//
// Pushed, not polled: the sidecar watches the repository (`RepositoryGitWatch`, the same watch
// behind the IDE's source-control list) and sends a status after every change git could report.
// The subscription is dropped while the page is hidden, because a subscription is what makes the
// sidecar run git, and nobody is looking; coming back subscribes again and gets the status at once.

import { useEffect, useState } from "react";
import type { BotGitStatus } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

export interface BotGitState {
  /** The last answer, or null before the first one arrives. */
  status: BotGitStatus | null;
  /** Why the stream last failed, or null since the last good status. The status is kept either way. */
  error: string | null;
}

export function useBotGitStatus(
  feed: SidecarDataSource,
  botId: string,
  /** False for a Bot whose directory is missing, which has no git to ask. */
  enabled: boolean,
): BotGitState {
  const [status, setStatus] = useState<BotGitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = usePageVisible();

  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [feed, botId]);

  useEffect(() => {
    if (!enabled || !visible) return;
    return feed.subscribeBotGit(
      botId,
      (answer) => {
        setStatus(answer);
        setError(null);
      },
      setError,
    );
  }, [feed, botId, enabled, visible]);

  return { status, error };
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
