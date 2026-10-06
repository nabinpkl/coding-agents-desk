"use client";

// Paging older transcript in from the top.

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Loads an older page when the reader nears the top of what is loaded.
 *
 * What it does NOT do is move the scroll when the page lands: the virtualizer runs with
 * `anchorTo: "end"`, which finds the row that was at the viewport before the prepend and puts it
 * back where it was, in the same pass that compensates for rows being measured. Doing it here as
 * well was the bug this replaced. The correction used to be the growth of `scrollHeight` between
 * the request and the page landing, which also counted every row above the viewport measured in
 * between -- growth the virtualizer had already compensated for. A jump to a user message near the
 * top of the window measured 6,667px of those and then paged, and landed 13,000px below the
 * message it was asked for (measured 2026-10-05).
 */
export function useOlderPageAnchor({
  loadOlder,
  virtualItems,
  windowStart,
}: {
  loadOlder: () => Promise<void>;
  virtualItems: readonly { index: number }[];
  windowStart: number;
}) {
  // One page at a time: set when a page is asked for, cleared when the window moves back.
  const pendingRef = useRef(false);
  const prevWindowStartRef = useRef<number>(0);

  useEffect(() => {
    const first = virtualItems[0];
    if (first && first.index < 20 && windowStart > 0 && !pendingRef.current) {
      pendingRef.current = true;
      void loadOlder();
    }
  }, [virtualItems, windowStart, loadOlder]);

  useLayoutEffect(() => {
    if (windowStart < prevWindowStartRef.current) pendingRef.current = false;
    prevWindowStartRef.current = windowStart;
  }, [windowStart]);
}
