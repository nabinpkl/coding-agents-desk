"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SummaryResult } from "@agentdesk/agent-feed-wire";
import type {
  SessionAddress,
  SidecarDataSource,
} from "../activity-feed/data-source/SidecarDataSource";

export type SummaryState =
  | { kind: "idle" }
  | { kind: "pending" }
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
 * The Summarize button's whole state.
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
  // Which session the in-flight request was issued for, so a slow answer that lands after the
  // viewer moved on is dropped instead of rendered against the wrong thread.
  const pendingFor = useRef<string | null>(null);

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

  const key = session ? `${session.source}/${session.sessionId}` : null;
  useEffect(() => {
    pendingFor.current = null;
    setState({ kind: "idle" });
  }, [key]);

  const summarize = useCallback(() => {
    if (!session || !key) return;
    pendingFor.current = key;
    setState({ kind: "pending" });
    void feed.summarizeTurn(session).then(
      (result) => {
        if (pendingFor.current !== key) return;
        setState({ kind: "ready", result });
      },
      (error: unknown) => {
        if (pendingFor.current !== key) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [feed, key, session]);

  const dismiss = useCallback(() => {
    pendingFor.current = null;
    setState({ kind: "idle" });
  }, []);

  return { available, model, state, summarize, dismiss };
}
