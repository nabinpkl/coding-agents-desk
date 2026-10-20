// Brings one session's card into view on the canvas, asked for from outside it: the Canvas tab's
// Sessions view, whose rows sit beside the canvas rather than on it.
//
// A request rather than a scroll done by the caller, because the card may not exist yet when it is
// asked for. Showing a session also opens its card and puts its Bot back on the canvas if it was
// off, and a Bot coming back waits for its record to be written, so the card can arrive a few
// renders later. The canvas holds the request and scrolls once the card is drawn.
//
// Opening a card already scrolls its Bot card into view (`BotCanvasCard`), but only on the
// transition to open: a card that was open and scrolled off stayed where it was. And that scrolls
// the Bot card, which can be wider than the canvas, not the session inside it.

import { useRef, type RefObject } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useDomSync } from "@/hooks/dom/useDomSync";

/**
 * How long a request waits for its card. A card that never comes (its machine is hidden, say) must
 * not be scrolled to minutes later, when the reader is somewhere else.
 */
const REQUEST_LIFETIME_MS = 5_000;

interface RevealRequest {
  /** `source:sessionId`, which the card carries as `data-session-key`. */
  key: string;
  at: number;
}

// The page's, not a component's: the row that asks is in the sidebar and the canvas that answers
// is beside it, with nothing between them but the app shell.
const store = createStore<{ request: RevealRequest | null }>(() => ({ request: null }));

/** Asks the canvas to bring this session's card into view, now or as soon as it is drawn. */
export function revealOnCanvas(key: string): void {
  store.setState({ request: { key, at: Date.now() } });
}

/**
 * Scrolls the asked-for card into view inside `canvas`, the canvas's scroller.
 *
 * Runs on every render of the canvas while a request is waiting, because what brings the card is
 * a render: the Bot's record coming back, or the card opening. Each request is answered once.
 * `nearest` on both axes, so a card already in full view does not move, and the session card
 * rather than its Bot card, so a wide Bot scrolls to the session asked for.
 */
export function useRevealOnCanvas(canvas: RefObject<HTMLElement | null>): void {
  const asked = useStore(store, (state) => state.request);
  const answered = useRef<RevealRequest | null>(null);
  useDomSync(() => {
    if (asked === null || answered.current === asked) return;
    if (Date.now() - asked.at > REQUEST_LIFETIME_MS) {
      answered.current = asked;
      return;
    }
    const card = canvas.current?.querySelector(`[data-session-key="${CSS.escape(asked.key)}"]`);
    if (!card) return;
    answered.current = asked;
    card.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  });
}
