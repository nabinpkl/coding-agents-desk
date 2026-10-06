"use client";

// The user bar's message when no held row stands for it, and the jump that lands on it.
//
// The bar names the last thing the reader said above the top of the viewport (ADR-0125). When the
// range of rows the top is in holds no such message, it is above where that range starts, and the
// sidecar walks back from there to the first one (`last-message?before=&said=1`). One answer is
// kept while that position is unchanged and none is cached past it: a message the reader sends
// arrives in the stream and is found among the held rows.
//
// The jump opens a range around the message (`loadAround`) and lands on it: one read wherever the
// message is, where this used to page back through every row between it and the reader.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { LastSessionMessage } from "@agentdesk/agent-feed-wire";
import { useDataSource } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { SidecarError } from "@/features/activity-feed/data-source/sidecarRoutes";
import { isEventItem, leadEvent, type FeedItem } from "@/features/activity-feed/rows/activityDisplayItems";
import type { RemoteUserBar } from "@/features/activity-feed/sticky-headers/useStickyIndices";

/** The last thing said before `before`, asked once per position. Null `before` asks nothing. */
export function useRemoteUserBar(
  sessionId: string,
  before: number | null,
): { message: LastSessionMessage | null; remote: RemoteUserBar | null } {
  const ds = useDataSource();
  const [answer, setAnswer] = useState<{ before: number; message: LastSessionMessage | null } | null>(null);
  useEffect(() => {
    if (before === null) return;
    let cancelled = false;
    ds.lastMessage(sessionId, { said: true, before }).then(
      (message) => {
        if (cancelled) return;
        // Checked rather than trusted: the bar renders the text and the jump reads around the index.
        if (typeof message?.text !== "string" || typeof message.index !== "number") {
          console.error(`[user bar] the sidecar's answer for ${before} is not a message`, message);
          setAnswer({ before, message: null });
          return;
        }
        setAnswer({ before, message });
      },
      (error: unknown) => {
        if (cancelled) return;
        // A 404 is an answer: nothing was said above this position. Anything else is a failure,
        // and the bar stays down rather than naming a message it could not find.
        if (!(error instanceof SidecarError && error.status === 404)) {
          console.error(`[user bar] could not ask for the message before ${before}`, error);
        }
        setAnswer({ before, message: null });
      },
    );
    return () => { cancelled = true; };
  }, [ds, sessionId, before]);
  const current = answer !== null && answer.before === before ? answer : null;
  return {
    message: current?.message ?? null,
    remote: current === null ? null : { before: current.before, found: current.message !== null },
  };
}

/**
 * Lands on a message the bar named, whether or not it is held: a held row is scrolled to at once,
 * and an unheld one is read around first.
 */
export function useJumpToMessage({
  flashHighlight,
  items,
  loadAround,
  pause,
  rowVirtualizer,
}: {
  flashHighlight: (eventIndex: number) => void;
  items: readonly FeedItem[];
  loadAround: (position: number) => Promise<void>;
  pause: () => void;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
}): (message: LastSessionMessage) => void {
  // The message being landed on, and whether its page has come back yet.
  const [seeking, setSeeking] = useState<{ eventId: string; read: boolean } | null>(null);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => {
    if (seeking === null) return;
    const rowIndex = items.findIndex((item) => isEventItem(item) && leadEvent(item).id === seeking.eventId);
    const found = items[rowIndex];
    if (found && isEventItem(found)) {
      setSeeking(null);
      rowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
      flashHighlight(leadEvent(found).index);
      return;
    }
    // The page came back without it: a snapshot replaced the window while it was in flight.
    if (seeking.read) {
      console.warn(`[user bar] the page around ${seeking.eventId} did not hold it`);
      setSeeking(null);
    }
  }, [seeking, items, rowVirtualizer, flashHighlight]);

  return useCallback((message: LastSessionMessage) => {
    pause();
    const held = itemsRef.current.some((item) => isEventItem(item) && leadEvent(item).id === message.eventId);
    setSeeking({ eventId: message.eventId, read: held });
    if (held) return;
    loadAround(message.index).then(
      () => setSeeking((current) => current?.eventId === message.eventId ? { ...current, read: true } : current),
      (error: unknown) => {
        console.error(`[user bar] could not read the rows around ${message.eventId}`, error);
        setSeeking(null);
      },
    );
  }, [loadAround, pause]);
}
