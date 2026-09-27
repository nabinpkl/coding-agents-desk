"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectoryEntry, Message, MessageAddress } from "@agentdesk/agent-feed-wire";
import type { HubHandle } from "@/features/activity-feed/data-source/layers/SidecarHub";

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
  send: (input: { to: string; body: string; kind?: "request" | "notice" }) => Promise<void>;
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

/**
 * The inbox's data: the owner's threads and the hub's directory, plus the three writes.
 *
 * Threads are re-read on a timer while the surface is open rather than streamed. The hub's stream
 * is per session, and the inbox is a view of every thread the owner is in at once, so there is no
 * one stream to hold; a ten-second poll is what keeps a reply from arriving minutes after the agent
 * sent it, and the panel is on a tailnet where that read is small.
 */
export function useMessages(hub: HubHandle): MessagesHandle {
  const [state, setState] = useState<MessagesState>({ kind: "idle" });
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [threads, directory] = await Promise.all([hub.threads(), hub.directory()]);
      setState({ kind: "ready", threads, directory });
    } catch (error) {
      setState({ kind: "error", message: describe(error) });
    }
  }, [hub]);

  const load = useCallback(() => {
    if (loaded.current) return;
    loaded.current = true;
    setState({ kind: "loading" });
    void refresh();
    timer.current = setInterval(() => void refresh(), REFRESH_MS);
  }, [refresh]);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        setState({ kind: "error", message: describe(error) });
        throw error;
      }
      await refresh();
    },
    [refresh],
  );

  const send = useCallback((input: { to: string; body: string; kind?: "request" | "notice" }) => act(() => hub.send(input)), [act, hub]);
  const reply = useCallback((messageId: string, body: string) => act(() => hub.reply(messageId, body)), [act, hub]);
  const cancel = useCallback((messageId: string) => act(() => hub.cancel(messageId)), [act, hub]);

  const addressable = useMemo(
    () =>
      state.kind === "ready"
        ? state.directory.filter((entry): entry is DirectoryEntry => (entry.address as MessageAddress) !== "human")
        : [],
    [state],
  );

  return { state, load, refresh, send, reply, cancel, addressable };
}
