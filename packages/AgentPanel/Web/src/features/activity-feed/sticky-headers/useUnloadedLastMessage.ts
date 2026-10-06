"use client";

// The reader's newest message when the feed has not loaded it, for the user bar to stand for.
//
// The feed opens on the newest page of events. A turn that runs past a page -- an agent left to
// work through a few hundred tool calls -- leaves none of the reader's messages in it, so the bar
// that names what they asked went blank exactly when there was most to scroll through. The sidecar
// can name that message without the feed paging back to it (`/last-message`, the same read "Fork
// from last message" makes), so the bar asks; a click pages back until the row is loaded and
// lands on it.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { LastSessionMessage } from "@agentdesk/agent-feed-wire";
import type { AgentSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { useDataSource } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { isEventItem, leadEvent, type FeedItem } from "@/features/activity-feed/rows/activityDisplayItems";
import { hasPersonRow } from "@/features/activity-feed/sticky-headers/activityStickyHeaders";

export function useUnloadedLastMessage({
  flashHighlight,
  items,
  loadOlder,
  pause,
  rowVirtualizer,
  sessionId,
  source,
  windowStart,
}: {
  flashHighlight: (eventIndex: number) => void;
  items: readonly FeedItem[];
  loadOlder: () => Promise<void>;
  pause: () => void;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  sessionId: string;
  source: AgentSource;
  /** First loaded event. Above zero means there is transcript the feed has not paged in. */
  windowStart: number;
}): { message: LastSessionMessage | null; jump: () => void } {
  const ds = useDataSource();
  const loadedPersonRow = useMemo(() => hasPersonRow(items), [items]);
  // Only when nothing loaded is a message of theirs: then everything loaded came after the newest
  // one, so the newest one is the right message for every row. Any loaded message means the bar
  // has a row to stand for, and one scrolled above it is older than the sidecar's answer.
  const needed = source === "claude" && windowStart > 0 && !loadedPersonRow;

  const [message, setMessage] = useState<LastSessionMessage | null>(null);
  useEffect(() => {
    setMessage(null);
    if (!needed) return;
    let cancelled = false;
    // `said`: a bare slash command is not something the bar names when it is loaded either, so the
    // sidecar passes over it to the message before. Refusing it here instead left the bar blank
    // for any session whose newest message was `/compact`.
    ds.lastMessage(sessionId, { said: true }).then(
      (found) => {
        if (cancelled || typeof found?.text !== "string") return;
        setMessage(found);
      },
      // Nothing said yet, or no answer: no bar, as before the bar could ask.
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [needed, ds, sessionId]);

  const [seeking, setSeeking] = useState<string | null>(null);
  useEffect(() => {
    if (seeking === null) return;
    const rowIndex = items.findIndex((item) => item.kind === "user" && leadEvent(item).id === seeking);
    const found = items[rowIndex];
    if (found && isEventItem(found)) {
      setSeeking(null);
      rowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
      flashHighlight(leadEvent(found).index);
      return;
    }
    // Paged back to the start without meeting it, which a rewound transcript can do: stop.
    if (windowStart <= 0) {
      setSeeking(null);
      return;
    }
    // One page per pass; the page landing changes `items` and runs this again.
    loadOlder().catch(() => setSeeking(null));
  }, [seeking, items, windowStart, loadOlder, rowVirtualizer, flashHighlight]);

  const jump = useCallback(() => {
    if (!message) return;
    pause();
    setSeeking(message.eventId);
  }, [message, pause]);

  return { message: needed ? message : null, jump };
}
