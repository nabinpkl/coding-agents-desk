"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SummaryResult, SummaryStep } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "../activity-feed/data-source/SidecarDataSource";

export type SummaryState =
  | { kind: "idle" }
  /** The run, as far as it has got. `thought` is the reasoning block still arriving. */
  | { kind: "pending"; steps: SummaryStep[]; thought: string }
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
  const [available, setAvailable] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [state, setState] = useState<SummaryState>({ kind: "idle" });
  // The open stream, so a terminal message can close it and a thread switch can abandon it.
  // Held in a ref rather than state because closing it is not a render.
  const stream = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void feed.fetchConfig().then(
      (config) => {
        if (cancelled) return;
        setAvailable(config.summaryEnabled);
        setModel(config.summaryModel);
      },
      // A config read that fails means the sidecar is not answering; the button stays hidden and
      // the panel's own connection errors are what the viewer sees.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [feed]);

  const close = useCallback(() => {
    stream.current?.();
    stream.current = null;
  }, []);

  const key = session ? `${session.source}/${session.sessionId}` : null;
  useEffect(() => {
    close();
    setState({ kind: "idle" });
  }, [close, key]);

  // A viewer who navigates away mid-run should not leave a stream open behind them. The run
  // itself continues on the sidecar and is joinable; only this reader goes.
  useEffect(() => close, [close]);

  const summarize = useCallback(() => {
    if (!session || stream.current) return;
    setState({ kind: "pending", steps: [], thought: "" });
    stream.current = feed.summarizeTurn(session, {
      onMessage: (message) => {
        switch (message.type) {
          case "thinking-delta":
            setState((current) =>
              current.kind === "pending"
                ? { ...current, thought: current.thought + message.text }
                : current);
            return;
          case "step":
            setState((current) =>
              current.kind === "pending"
                ? {
                    kind: "pending",
                    steps: [...current.steps, message.step],
                    // A finished thought replaces what its own deltas built, rather than being
                    // appended beside it: they are the same thought and showing both reads as
                    // two. A lookup clears nothing -- it is not what the deltas were building.
                    thought: message.step.kind === "thinking" ? "" : current.thought,
                  }
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
