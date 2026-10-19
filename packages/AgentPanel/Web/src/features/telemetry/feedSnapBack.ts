// A transcript's tail follower pulling a reader back to the end after they wheeled up, recorded as
// a span of its own so the archive can say why it happened. Reported 2026-10-18 on the Mac: a
// Claude card, handed over from opencode, would not let the reader scroll up during its first heavy
// turn, and a reload cleared it. Neither a fresh browser nor a streaming throwaway reproduced it,
// so the record is taken where it happens. `useSnapBackWitness` decides when one is worth sending.
//
// Its own trace, and a `ui.` op, because that is what `tracesSampler` in `panelTelemetry.ts` keeps
// once the page load is over. `startNewTrace` also clears the active span, so this is a root span
// even while a page load is still open. With no client installed (tests, the fixture) this sends nothing.

import { startInactiveSpan, startNewTrace } from "@sentry/react";

export type FeedSnapBack = {
  /** `source:sessionId` of the transcript. */
  session: string;
  /** What snapped: the content growing (`resize`), or a scroll the follower read as layout (`scroll`). */
  cause: "resize" | "scroll";
  /** How far the reader had risen from where the follower last put them, which the snap undid. */
  upPx: number;
  /** Since the last upward wheel over this transcript, as the window saw it. */
  wheelAgoMs: number;
  /** Since the follower's own last upward input, or -1 when it has never had one. */
  intentAgoMs: number;
  /** Whether the follower's own wheel listener received that same wheel. */
  hookSawWheel: boolean;
  /** Whether the snap landed inside the fence of the previous one. */
  enforcing: boolean;
  scrollbarHeld: boolean;
  scrollHeight: number;
  clientHeight: number;
  /** Snaps of this kind since the last one reported, which the throttle held back. */
  heldBack: number;
};

export function reportFeedSnapBack(snap: FeedSnapBack): void {
  startNewTrace(() => {
    startInactiveSpan({
      name: "feed snapped a scroll-up back",
      op: "ui.feed.snap-back",
      attributes: {
        "feed.session": snap.session,
        "feed.cause": snap.cause,
        "feed.up_px": snap.upPx,
        "feed.wheel_ago_ms": snap.wheelAgoMs,
        "feed.intent_ago_ms": snap.intentAgoMs,
        "feed.hook_saw_wheel": snap.hookSawWheel,
        "feed.enforcing": snap.enforcing,
        "feed.scrollbar_held": snap.scrollbarHeld,
        "feed.scroll_height": snap.scrollHeight,
        "feed.client_height": snap.clientHeight,
        "feed.held_back": snap.heldBack,
      },
    }).end();
  });
}
