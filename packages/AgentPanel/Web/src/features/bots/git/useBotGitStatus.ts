// What git says about a Bot's directory, kept roughly current while the card is on screen.
//
// Polled rather than streamed. The IDE's git status rides its workspace stream because a workspace
// has a watcher behind it; a Bot's directory has none, and giving every Bot a recursive watch to
// move one number on a header would cost more than asking git every few seconds. A hidden tab
// asks nothing, and coming back asks at once, so the count a reader returns to is never stale.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BotGitStatus } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/** How often a visible card asks again. Agents write files in bursts, so seconds, not minutes. */
export const BOT_GIT_POLL_MS = 10_000;

export interface BotGitState {
  /** The last answer, or null before the first one arrives. */
  status: BotGitStatus | null;
  /** Why the last read failed, or null when it did not. The last good status is kept either way. */
  error: string | null;
  /** Ask now, for a reader who opened the changes and should not wait for the next tick. */
  refresh: () => void;
}

export function useBotGitStatus(
  feed: SidecarDataSource,
  botId: string,
  /** False for a Bot whose directory is missing, which has no git to ask. */
  enabled: boolean,
): BotGitState {
  const [status, setStatus] = useState<BotGitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever the thing being read changes, so an answer about the previous Bot or machine
  // that lands late is dropped rather than drawn on this one.
  const generation = useRef(0);

  const read = useCallback(() => {
    const asked = generation.current;
    feed.botGitStatus(botId).then(
      (answer) => {
        if (generation.current !== asked) return;
        setStatus(answer);
        setError(null);
      },
      (cause: unknown) => {
        if (generation.current !== asked) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [feed, botId]);

  useEffect(() => {
    generation.current += 1;
    setStatus(null);
    setError(null);
    if (!enabled) return;
    read();
    const timer = window.setInterval(() => {
      if (!document.hidden) read();
    }, BOT_GIT_POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read, enabled]);

  return { status, error, refresh: read };
}
