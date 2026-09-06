"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CliInputStatus, CliInputUnavailableReason } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "../activity-feed/data-source/SidecarDataSource";

export interface CliInputHandle {
  /**
   * True when this session is a Claude Code process running in a terminal. It is what selects the
   * composer: a terminal session has no window field to mirror, so the two-way window composer has
   * nothing to sync and the local-draft one is the only honest offer.
   */
  isTerminalSession: boolean;
  /** True when a turn can be delivered right now. */
  available: boolean;
  reason: CliInputUnavailableReason | null;
  /** Re-asks the harness. Called when someone focuses the field, which is when the answer matters. */
  refresh: () => void;
  /** Resolves false, with `reason` set, when the session could not take the turn. */
  send: (text: string) => Promise<boolean>;
}

const IDLE: CliInputStatus = {
  available: false, entrypoint: null, reason: null, tmuxSession: null,
};

/**
 * Whether the selected session is a terminal Claude session, and the means to type into it.
 *
 * Asked of the sidecar rather than derived from the session row, because it is a fact about a live
 * PROCESS. Two rows for the same project look identical whether one of them is a `claude` running
 * in a window right now and the other is a transcript whose terminal was closed last week.
 *
 * There is no timer. The status is re-read when the selection changes and when someone focuses the
 * field, which are the two moments it is about to be acted on; a failed send re-reads it too, so a
 * session that died under the composer corrects itself at exactly the point the viewer notices.
 * A poll would buy nothing except a request every few seconds per open panel.
 */
export function useCliInput(
  feed: Pick<SidecarDataSource, "cliInputStatus" | "sendCliInput">,
  session: SessionAddress | null,
  active: boolean,
): CliInputHandle {
  const [status, setStatus] = useState<CliInputStatus>(IDLE);
  // Which session the in-flight read was issued for, so an answer that lands after the viewer
  // moved on cannot enable a composer against a different thread.
  const readFor = useRef<string | null>(null);
  // The address is a fresh object on every render of the caller, so it cannot be a dependency:
  // an effect that depended on it would re-run on every render, and its own `setStatus` would
  // cause the next one. Held in a ref and keyed by identity instead.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const key = session && active ? `${session.source}/${session.sessionId}` : null;

  const read = useCallback(() => {
    const address = sessionRef.current;
    if (!address || !key) return;
    readFor.current = key;
    void feed.cliInputStatus(address).then(
      (next) => {
        if (readFor.current !== key) return;
        setStatus(next);
      },
      // A failed read means the sidecar is not answering, which the panel already surfaces through
      // its own connection state. Leaving the status alone keeps a working composer working across
      // one dropped request instead of collapsing it to "unavailable".
      () => {},
    );
  }, [feed, key]);

  useEffect(() => {
    setStatus(IDLE);
    readFor.current = null;
    if (key) read();
  }, [key, read]);

  const send = useCallback(async (text: string): Promise<boolean> => {
    const address = sessionRef.current;
    if (!address) return false;
    const receipt = await feed.sendCliInput(address, text);
    if (!receipt.delivered) {
      // The receipt is newer than the status that let the field be typed into, so it replaces it.
      // Entrypoint is preserved: the session is still a terminal session, it just stopped running,
      // and dropping that would swap the composer out from under the failure message.
      setStatus((current) => ({ ...current, available: false, reason: receipt.reason }));
    }
    return receipt.delivered;
  }, [feed]);

  return {
    isTerminalSession: status.entrypoint === "cli",
    available: status.available,
    reason: status.reason,
    // No `tmuxSession` here on purpose: the terminal composer used to take the pane name from it
    // and now names the session instead, leaving nothing that reads it. The sidecar still reports
    // it on the status, and resolves it there, where a live answer is a live answer.
    refresh: read,
    send,
  };
}

/** What each reason means to someone looking at a disabled field. */
export function cliInputReasonText(reason: CliInputUnavailableReason): string {
  switch (reason) {
    case "not-running":
      return "This session is not running. Start it in a terminal to send.";
    case "no-inbox":
      return "This session's Claude Code build does not accept messages.";
    case "no-key":
      return "This session's message key is missing, so it cannot be reached.";
    case "unreachable":
      return "This session stopped listening. It has probably exited.";
    case "delivery-failed":
      return "The session did not take the message.";
  }
}
