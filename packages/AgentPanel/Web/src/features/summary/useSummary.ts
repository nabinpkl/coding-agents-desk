"use client";

import { useCallback, useRef } from "react";
import type { SummaryResult } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "@/features/activity-feed/data-source/SidecarDataSource";
import { useLeaveEffect } from "@/hooks/useMountEffect";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useSidecarConfig } from "@/query/sidecarConfig";

export type SummaryState =
  | { kind: "idle" }
  /** The run, as far as it has got. `thought` is the reasoning block still arriving. */
  | { kind: "pending"; reasoning: string[]; thought: string }
  | { kind: "ready"; result: SummaryResult }
  | { kind: "error"; message: string };

export interface SummaryHandle {
  /** False until the sidecar says it has a model credential. The control renders nothing. */
  available: boolean;
  /** `provider/model`, shown on the digest so a viewer knows what wrote it. */
  model: string | null;
  state: SummaryState;
  summarize: () => void;
  dismiss: () => void;
}

/**
 * The Summarize button's whole state, and the stream behind it.
 *
 * Availability is read once per mount from `/api/config` rather than per session: whether a
 * summarizer model is configured is a property of the sidecar, not of the thread on screen.
 *
 * The result is keyed to the session it was taken over and cleared when the selection changes.
 * A digest of the previous thread left on screen under a new thread's title is the one failure
 * mode worth designing against here -- it is wrong in a way that looks right.
 */
export function useSummary(
  feed: Pick<SidecarDataSource, "summarizeTurn" | "fetchConfig">,
  session: SessionAddress | null,
): SummaryHandle {
  // A config read that fails means the sidecar is not answering; the button stays hidden and the
  // panel's own connection errors are what the viewer sees.
  const config = useSidecarConfig(feed).data;
  const available = config?.summaryEnabled ?? false;
  const model = config?.summaryModel ?? null;
  // The open stream, so a terminal message can close it and a thread switch can abandon it.
  // Held in a ref rather than state because closing it is not a render.
  const stream = useRef<(() => void) | null>(null);


  const close = useCallback(() => {
    stream.current?.();
    stream.current = null;
  }, []);

  const key = session ? `${session.source}/${session.sessionId}` : null;
  const [state, setState] = useStateFor<SummaryState>(key, () => ({ kind: "idle" }));
  // A switch of thread, or a viewer who navigates away mid-run, should not leave a stream open
  // behind them. The run itself continues on the sidecar and is joinable; only this reader goes.
  useLeaveEffect(key, close);

  const summarize = useCallback(() => {
    if (!session || stream.current) return;
    setState({ kind: "pending", reasoning: [], thought: "" });
    stream.current = feed.summarizeTurn(session, {
      onMessage: (message) => {
        switch (message.type) {
          case "thinking-delta":
            setState((current) =>
              current.kind === "pending"
                ? { ...current, thought: current.thought + message.text }
                : current);
            return;
          case "reasoning":
            // The finished block replaces what its own deltas built rather than being appended
            // beside it: they are the same thought, and showing both reads as two.
            setState((current) =>
              current.kind === "pending"
                ? { kind: "pending", reasoning: [...current.reasoning, message.text], thought: "" }
                : current);
            return;
          case "result":
            close();
            setState({ kind: "ready", result: message.result });
            return;
          case "error":
            close();
            setState({ kind: "error", message: message.error.message });
        }
      },
      // A stream that never opened, or that dropped mid-run. Either way the digest is not
      // coming, and the band says so rather than spinning until the viewer gives up.
      onError: (reason) => {
        close();
        setState({ kind: "error", message: reason });
      },
    });
  }, [close, feed, session]);

  const dismiss = useCallback(() => {
    close();
    setState({ kind: "idle" });
  }, [close]);

  return { available, model, state, summarize, dismiss };
}
