"use client";

import { useCallback, useMemo } from "react";
import type { DirectoryEntry, Message, MessageAddress, SentMessageKind } from "@agentdesk/agent-feed-wire";
import type { HubHandle } from "@/features/activity-feed/data-source/layers/SidecarHub";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { createSourceStore, useSourceStore } from "@/features/activity-feed/data-source/sourceStore";

export type MessagesState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; threads: Message[][]; directory: DirectoryEntry[] }
  | { kind: "error"; message: string };

export interface MessagesHandle {
  state: MessagesState;
  /** Loads once; safe to call again. The inbox is a place a reader goes to, not a thing that loads itself. */
  load: () => void;
  /** Re-reads threads and the directory. Called after every send, so the state shown is the hub's. */
  refresh: () => Promise<void>;
  send: (input: { to: string; body: string; kind: SentMessageKind }) => Promise<void>;
  reply: (messageId: string, body: string) => Promise<void>;
  cancel: (messageId: string) => Promise<void>;
  /** Directory entries a person can be addressed by, Bots and sessions, human excluded. */
  addressable: DirectoryEntry[];
}

const REFRESH_MS = 10_000;

function describe(error: unknown): string {
  if (error instanceof Error) {
    const body = /"message"\s*:\s*"([^"]+)"/.exec(error.message);
    return body?.[1] ?? error.message;
  }
  return String(error);
}

/** Each hub's poll, so the last reader leaving can stop it. */
const timers = new WeakMap<HubHandle, ReturnType<typeof setInterval>>();

// The first inbox to open loads the threads and starts the poll; the last one to close stops it.
const store = createSourceStore<HubHandle, MessagesState>({
  initial: () => ({ kind: "idle" }),
  opened: (hub) => load(hub),
  closed: stop,
});

/** One hub per data source: `hub()` builds a new handle on every call, and the store keys on it. */
const hubs = new WeakMap<Pick<SidecarDataSource, "hub">, HubHandle>();

export function hubOf(feed: Pick<SidecarDataSource, "hub">): HubHandle {
  let hub = hubs.get(feed);
  if (!hub) {
    hub = feed.hub();
    hubs.set(feed, hub);
  }
  return hub;
}

async function refresh(hub: HubHandle): Promise<void> {
  try {
    const [threads, directory] = await Promise.all([hub.threads(), hub.directory()]);
    store.set(hub, () => ({ kind: "ready", threads, directory }));
  } catch (error) {
    store.set(hub, () => ({ kind: "error", message: describe(error) }));
  }
}

function load(hub: HubHandle): void {
  if (timers.has(hub)) return;
  // Threads already on screen stay while they are read again, rather than blinking to a spinner.
  store.set(hub, (current) => (current.kind === "ready" ? current : { kind: "loading" }));
  void refresh(hub);
  timers.set(hub, setInterval(() => void refresh(hub), REFRESH_MS));
}

function stop(hub: HubHandle): void {
  clearInterval(timers.get(hub));
  timers.delete(hub);
}

async function act(hub: HubHandle, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    store.set(hub, () => ({ kind: "error", message: describe(error) }));
    throw error;
  }
  await refresh(hub);
}

/**
 * The inbox's data: the owner's threads and the hub's directory, plus the three writes.
 *
 * Threads are re-read on a timer while the inbox is open rather than streamed. The hub's stream is
 * per session, and the inbox is a view of every thread the owner is in at once, so there is no one
 * stream to hold; a ten-second poll is what keeps a reply from arriving minutes after the agent
 * sent it, and the panel is on a tailnet where that read is small. The poll stops when the last
 * inbox closes.
 */
export function useMessages(hub: HubHandle): MessagesHandle {
  const state = useSourceStore(store, hub);
  const open = useCallback(() => load(hub), [hub]);
  const reread = useCallback(() => refresh(hub), [hub]);
  const send = useCallback(
    (input: { to: string; body: string; kind: SentMessageKind }) => act(hub, () => hub.send(input)),
    [hub],
  );
  const reply = useCallback((messageId: string, body: string) => act(hub, () => hub.reply(messageId, body)), [hub]);
  const cancel = useCallback((messageId: string) => act(hub, () => hub.cancel(messageId)), [hub]);
  const addressable = useMemo(
    () =>
      state.kind === "ready"
        ? state.directory.filter((entry): entry is DirectoryEntry => (entry.address as MessageAddress) !== "human")
        : [],
    [state],
  );
  return { state, load: open, refresh: reread, send, reply, cancel, addressable };
}
