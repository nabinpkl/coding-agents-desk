"use client";

// Moving the session in front of the reader between the terminal and the SDK runner (ADR-0143).
//
// The sidecar does the moving and every refusal; this holds what the band shows while it happens
// and after. The one thing it adds is noticing the result: the new process registers itself a moment
// after it starts, and the composer chooses its band from that registration, so it is read again a
// few times over the next seconds rather than once, too early.

import { useCallback, useRef, useState } from "react";
import type { ClaudeRunMode } from "@agentdesk/agent-feed-wire";
import type { SessionAddress, SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useLeaveEffect } from "@/hooks/useMountEffect";

/** When to read the registry again after a switch, in ms: bounded, and covering a slow start. */
const REREADS = [1_500, 4_000, 8_000] as const;

/** The sidecar's words as a sentence: capitalised, and closed. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

export function useRunModeSwitch(
  feed: Pick<SidecarDataSource, "switchClaudeRunMode">,
  session: SessionAddress,
  refresh: () => void,
) {
  const [pending, setPending] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const { source, sessionId } = session;

  // A different session starts clean, and nothing scheduled for the last one reads into it.
  const [error, setError] = useStateFor<string | null>(`${source}/${sessionId}`, () => null);
  useLeaveEffect(`${source}/${sessionId}`, () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  });

  const switchTo = useCallback(async (mode: ClaudeRunMode) => {
    setPending(true);
    setError(null);
    try {
      const outcome = await feed.switchClaudeRunMode({ source, sessionId }, mode);
      if (!outcome.ok) {
        setError(sentence(outcome.message));
        return;
      }
      timers.current = REREADS.map((delay) => setTimeout(refresh, delay));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, [feed, refresh, sessionId, source]);

  return { pending, error, switchTo };
}

export type RunModeSwitchHandle = ReturnType<typeof useRunModeSwitch>;
