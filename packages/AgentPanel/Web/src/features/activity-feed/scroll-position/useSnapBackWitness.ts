// Watches for the tail follower undoing a reader's upward wheel, and reports it
// (`reportFeedSnapBack`). Diagnostic only: nothing here changes what the follower does.
//
// The follower decides from its own wheel listener on the scroller, so it cannot be the witness to
// that listener missing a wheel. This one listens on the window instead, in the capture phase, and
// counts a wheel as being over the transcript when the scroller the ref holds NOW contains its
// target. Comparing the two answers the question the record exists for: whether the follower was
// handed the wheel and let it go, or never received it.

import { useRef } from "react";
import { reportFeedSnapBack, type FeedSnapBack } from "@/features/telemetry/feedSnapBack";
import { useEventListener } from "@/hooks/dom/useEventListener";

/**
 * How recent an upward wheel has to be for a snap to count as undoing it. Four times the follower's
 * own 250ms window: a snap just past that window is the case most worth seeing.
 */
const WITNESS_WINDOW_MS = 1000;

/** At most one report this often per transcript; the snaps in between are counted, not sent. */
const REPORT_EVERY_MS = 2000;

/** What the follower knows at the moment it snapped. */
export type SnapFacts = Pick<
  FeedSnapBack,
  "cause" | "upPx" | "enforcing" | "scrollbarHeld" | "scrollHeight" | "clientHeight"
> & {
  /** When the follower last had an upward input, from `performance.now()`. */
  intentAt: number;
};

export function useSnapBackWitness(
  scrollRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  session: string,
): { sawWheel: (event: WheelEvent) => void; snapped: (facts: SnapFacts) => void } {
  const upWheelRef = useRef<{ at: number; event: WheelEvent } | null>(null);
  const hookWheelRef = useRef<WheelEvent | null>(null);
  const reportedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const heldBackRef = useRef(0);

  useEventListener<WheelEvent>(
    active ? window : null,
    "wheel",
    (event) => {
      if (event.deltaY >= 0) return;
      const el = scrollRef.current;
      if (!el || !(event.target instanceof Node) || !el.contains(event.target)) return;
      upWheelRef.current = { at: performance.now(), event };
    },
    { capture: true, passive: true },
  );

  // Called by the follower's own wheel listener with every wheel it receives. Only the upward ones
  // are kept, as on the window: a trackpad's momentum ends in wheels of zero or downward delta, and
  // keeping those would make the follower look as if it had missed the upward wheel before them.
  const sawWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) hookWheelRef.current = event;
  };

  const snapped = (facts: SnapFacts) => {
    const wheel = upWheelRef.current;
    const now = performance.now();
    if (!wheel || now - wheel.at > WITNESS_WINDOW_MS) return;
    if (now - reportedAtRef.current < REPORT_EVERY_MS) {
      heldBackRef.current += 1;
      return;
    }
    const { intentAt, ...rest } = facts;
    reportFeedSnapBack({
      ...rest,
      session,
      wheelAgoMs: Math.round(now - wheel.at),
      intentAgoMs: Number.isFinite(intentAt) ? Math.round(now - intentAt) : -1,
      hookSawWheel: hookWheelRef.current === wheel.event,
      heldBack: heldBackRef.current,
    });
    reportedAtRef.current = now;
    heldBackRef.current = 0;
  };

  return { sawWheel, snapped };
}
