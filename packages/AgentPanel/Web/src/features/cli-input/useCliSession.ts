"use client";

import { useEffect, useRef, useState } from "react";
import type { CliSessionStatus } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "@/features/activity-feed/data-source/SidecarDataSource";

export interface CliSessionHandle {
  /**
   * True when this session is a Claude Code process running in a terminal. It is what selects the
   * composer: a terminal session has no window field to mirror, so the window composer has
   * nothing to sync, and the session is typed into through its tmux pane when it has one.
   */
  isTerminalSession: boolean;
  /**
   * True when it runs through the Agent SDK's runner instead (ADR-0143): typed into, asked and
   * answered through the runner, never through its pane, which shows the runner's log.
   */
  isSdkSession: boolean;
}

const IDLE: CliSessionStatus = { entrypoint: null, tmuxSession: null };

/**
 * Whether the selected session is a terminal Claude session.
 *
 * Asked of the sidecar rather than derived from the session row, because it is a fact about a live
 * PROCESS. Two rows for the same project look identical whether one of them is a `claude` running
 * in a window right now and the other is a transcript whose terminal was closed last week.
 *
 * Read when the selection changes, and not on a timer: it decides which composer to show, and a
 * session does not change how it was launched while it runs. Nothing here sends anything: the
 * messaging-socket delivery this hook used to carry was removed on 2026-10-16
 * (`wire/cliSession.ts`).
 */
export function useCliSession(
  feed: Pick<SidecarDataSource, "cliSessionStatus">,
  session: SessionAddress | null,
  active: boolean,
): CliSessionHandle {
  const [status, setStatus] = useState<CliSessionStatus>(IDLE);
  // Which session the in-flight read was issued for, so an answer that lands after the viewer
  // moved on cannot switch the composer for a different thread.
  const readFor = useRef<string | null>(null);
  // The address is a fresh object on every render of the caller, so it cannot be a dependency.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const key = session && active ? `${session.source}/${session.sessionId}` : null;

  useEffect(() => {
    setStatus(IDLE);
    readFor.current = key;
    const address = sessionRef.current;
    if (!key || !address) return;
    void feed.cliSessionStatus(address).then(
      (next) => {
        if (readFor.current === key) setStatus(next);
      },
      // A failed read means the sidecar is not answering, which the panel already surfaces through
      // its own connection state.
      () => {},
    );
  }, [feed, key]);

  return { isTerminalSession: status.entrypoint === "cli", isSdkSession: status.entrypoint === "sdk-cli" };
}
