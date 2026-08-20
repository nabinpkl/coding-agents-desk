"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageReport, UsageVendorId } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";

export type UsageState =
  | { kind: "idle" }
  /** Nothing to paint yet. The first sweep on a cold cache takes seconds. */
  | { kind: "loading" }
  /** A report is on screen; `settled` is false while a sweep may still correct it. */
  | { kind: "ready"; report: UsageReport; settled: boolean }
  | { kind: "error"; message: string };

export interface UsageHandle {
  /** Vendors this machine has records for. Empty hides the Usage entry entirely. */
  vendors: UsageVendorId[];
  state: UsageState;
  /** Opens the stream. Safe to call again; a second call while one is open does nothing. */
  load: () => void;
}

/**
 * The Usage modal's data, and the stream behind it.
 *
 * Availability is read from `/api/config` on mount rather than per open, the same way the
 * summarizer's is: whether this machine has Codex records is a property of the machine.
 *
 * The stream is opened on demand rather than at mount. A sweep reads gigabytes on a cold cache,
 * and doing that because the panel launched -- rather than because somebody asked what their week
 * cost -- would spend the disk on a question nobody had.
 */
export function useUsage(
  feed: Pick<SidecarDataSource, "subscribeUsage" | "fetchConfig">,
): UsageHandle {
  const [vendors, setVendors] = useState<UsageVendorId[]>([]);
  const [state, setState] = useState<UsageState>({ kind: "idle" });
  // The open stream, so a terminal message or an unmount can close it. A ref rather than state
  // because closing it is not a render.
  const stream = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void feed.fetchConfig().then(
      (config) => {
        // A config this panel cannot read a vendor list out of means "offer nothing", the same
        // answer a failed read gives. This is an availability probe, not a data path: refusing to
        // render because the field is absent would take the whole sidebar down over a menu entry.
        if (!cancelled) setVendors(Array.isArray(config.usageVendors) ? config.usageVendors : []);
      },
      // A config read that fails means the sidecar is not answering, and the panel's own
      // connection errors are what the viewer sees. The entry stays hidden rather than offering
      // something that cannot work.
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

  useEffect(() => close, [close]);

  const load = useCallback(() => {
    if (stream.current) return;
    setState((current) => (current.kind === "ready" ? { ...current, settled: false } : { kind: "loading" }));
    stream.current = feed.subscribeUsage({
      onMessage: (message) => {
        switch (message.type) {
          case "report":
            // Deliberately not closed here: the first report can be the cache's, with the
            // sweep's still to come.
            setState({ kind: "ready", report: message.report, settled: false });
            return;
          case "settled":
            close();
            setState((current) =>
              current.kind === "ready" ? { ...current, settled: true } : { kind: "idle" });
            return;
          case "error":
            close();
            setState({ kind: "error", message: message.error.message });
        }
      },
      // The stream never opened, or dropped before it settled. A report already on screen stays
      // -- it was real when it arrived -- and stops claiming a sweep is still running.
      onError: (reason) => {
        close();
        setState((current) =>
          current.kind === "ready"
            ? { ...current, settled: true }
            : { kind: "error", message: reason });
      },
    });
  }, [close, feed]);

  return { vendors, state, load };
}
