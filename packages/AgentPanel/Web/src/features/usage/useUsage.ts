"use client";

import { useCallback } from "react";
import type { UsageReport, UsageVendorId } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { createSourceStore, useSourceStore } from "@/features/activity-feed/data-source/sourceStore";

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

export type UsageFeed = Pick<SidecarDataSource, "subscribeUsage" | "fetchConfig">;

interface UsageEntry {
  vendors: UsageVendorId[];
  state: UsageState;
}

/** Each machine's open stream, so a terminal message or the last reader leaving can close it. */
const streams = new WeakMap<UsageFeed, () => void>();
/** Machines whose config has been asked for, so a second reader does not ask again. */
const asked = new WeakSet<UsageFeed>();

const store = createSourceStore<UsageFeed, UsageEntry>({
  initial: () => ({ vendors: [], state: { kind: "idle" } }),
  opened: readVendors,
  closed: close,
});

function setState(feed: UsageFeed, next: (current: UsageState) => UsageState): void {
  store.set(feed, (entry) => ({ ...entry, state: next(entry.state) }));
}

/**
 * Availability is read from `/api/config` when the first reader arrives rather than per open, the
 * same way the summarizer's is: whether this machine has Codex records is a property of the
 * machine.
 */
function readVendors(feed: UsageFeed): void {
  if (asked.has(feed)) return;
  asked.add(feed);
  void feed.fetchConfig().then(
    (config) => {
      // A config this panel cannot read a vendor list out of means "offer nothing", the same
      // answer a failed read gives. This is an availability probe, not a data path: refusing to
      // render because the field is absent would take the whole sidebar down over a menu entry.
      const vendors = Array.isArray(config.usageVendors) ? config.usageVendors : [];
      store.set(feed, (entry) => ({ ...entry, vendors }));
    },
    // A config read that fails means the sidecar is not answering, and the panel's own connection
    // errors are what the viewer sees. The entry stays hidden, and the next reader asks again.
    () => asked.delete(feed),
  );
}

function close(feed: UsageFeed): void {
  streams.get(feed)?.();
  streams.delete(feed);
}

/**
 * Opens the stream. The first report can be the cache's, with the sweep's still to come, so it
 * stays open until the sidecar says the sweep has settled.
 */
function load(feed: UsageFeed): void {
  if (streams.has(feed)) return;
  setState(feed, (current) => (current.kind === "ready" ? { ...current, settled: false } : { kind: "loading" }));
  streams.set(
    feed,
    feed.subscribeUsage({
      onMessage: (message) => {
        switch (message.type) {
          case "report":
            setState(feed, () => ({ kind: "ready", report: message.report, settled: false }));
            return;
          case "settled":
            close(feed);
            setState(feed, (current) => (current.kind === "ready" ? { ...current, settled: true } : { kind: "idle" }));
            return;
          case "error":
            close(feed);
            setState(feed, () => ({ kind: "error", message: message.error.message }));
        }
      },
      // The stream never opened, or dropped before it settled. A report already on screen stays --
      // it was real when it arrived -- and stops claiming a sweep is still running.
      onError: (reason) => {
        close(feed);
        setState(feed, (current) =>
          current.kind === "ready" ? { ...current, settled: true } : { kind: "error", message: reason },
        );
      },
    }),
  );
}

/**
 * The Usage modal's data, and the stream behind it.
 *
 * The stream is opened on demand rather than when the row mounts. A sweep reads gigabytes on a cold
 * cache, and doing that because the panel launched -- rather than because somebody asked what their
 * week cost -- would spend the disk on a question nobody had.
 */
export function useUsage(feed: UsageFeed): UsageHandle {
  const { vendors, state } = useSourceStore(store, feed);
  const open = useCallback(() => load(feed), [feed]);
  return { vendors, state, load: open };
}
