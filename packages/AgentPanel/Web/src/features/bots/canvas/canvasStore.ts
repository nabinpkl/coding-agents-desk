// What the canvas is asked from outside its own tree, held where only the cards it is about
// re-render for it.
//
// Today that is one request: the Canvas tab's Sessions view asking to see one session's card
// (`ProjectSidebarItem`'s "Show on canvas"). The rows sit beside the canvas rather than on it, so the
// request cannot travel as a prop, and it is not state `App` should hold either: every card would
// re-render for a fact about one of them.
//
// A zustand store made once per shell (`createCanvasStore`) and handed to the canvas through
// `CanvasShell`, rather than one module-level store, so every render of the app starts with its own
// and a test needs no reset. See ADR-0149.

import { useCallback, useContext, createContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

export interface CanvasStoreState {
  /**
   * The session the reader asked to see, as `source:sessionId`, or null.
   *
   * State rather than an event, because the card may not be drawn yet when it is asked for: showing
   * a session also opens its card and puts its Bot back on the canvas if it was off, and a Bot coming
   * back waits for its record to be written. The card scrolls itself to it when it is there, and that
   * answers it. A card that never comes (its machine is hidden) leaves it waiting until the reader
   * takes the canvas in hand, which drops it, rather than until a clock says so.
   */
  revealKey: string | null;
  reveal: (key: string) => void;
  /** Answers the request for `key` and only that one, so an ask made since stays. */
  revealed: (key: string) => void;
  /** Drops whatever is waiting: the reader pressed or scrolled the canvas themselves. */
  dropReveal: () => void;
}

export type CanvasStore = StoreApi<CanvasStoreState>;

export function createCanvasStore(): CanvasStore {
  return createStore<CanvasStoreState>()((set, get) => ({
    revealKey: null,
    reveal: (key) => set({ revealKey: key }),
    revealed: (key) => {
      if (get().revealKey === key) set({ revealKey: null });
    },
    // Asked on every wheel tick over the canvas, so it writes only when there is something to drop.
    dropReveal: () => {
      if (get().revealKey !== null) set({ revealKey: null });
    },
  }));
}

export const CanvasStoreContext = createContext<CanvasStore | null>(null);

function useCanvasStoreApi(): CanvasStore {
  const store = useContext(CanvasStoreContext);
  if (store === null) throw new Error("A canvas card rendered outside CanvasShell");
  return store;
}

/**
 * Reads one answer from the canvas's store, re-rendering only when that answer changes.
 *
 * The selector returns a value, never a fresh object or array: zustand compares answers by identity,
 * and a new one on every read re-renders forever.
 */
export function useCanvasStore<T>(selector: (state: CanvasStoreState) => T): T {
  return useStore(useCanvasStoreApi(), selector);
}

/**
 * A ref for the card of `key`, which scrolls it into view when the reader has asked to see it.
 *
 * On the card itself rather than searched for from the canvas, so a card drawn after the ask scrolls
 * the moment it arrives and one drawn before it scrolls the moment it is asked: the ref is attached
 * again whenever `asked` changes, and attaching is what scrolls. `nearest` on both axes, so a card
 * already in full view does not move, and the session's card rather than its Bot's, so a Bot wider
 * than the canvas scrolls to the session asked for. Then the card is ringed for a moment
 * (`ringRevealed`), because on a canvas of thirty cards arriving in view is not the same as being
 * found.
 */
export function useRevealWhenAsked(key: string): (node: HTMLElement | null) => void {
  const store = useCanvasStoreApi();
  const asked = useStore(store, (state) => state.revealKey === key);
  return useCallback(
    (node: HTMLElement | null) => {
      if (node === null || !asked) return;
      node.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
      ringRevealed(node);
      store.getState().revealed(key);
    },
    [asked, key, store],
  );
}

/** How long the ring lasts, and how long it waits for the smooth scroll to land before it starts. */
const RING_MS = 1400;
const RING_DELAY_MS = 250;

/**
 * Two beats of a ring on the card's rounded box, then nothing.
 *
 * An outline rather than a border or a shadow: it takes no room, so nothing beside the card moves,
 * and with a negative offset it is drawn just inside the card's edge, where the Bot card that clips
 * whatever hangs past its sessions cannot cut it off. Animated here rather than by a class, because
 * the card's classes are React's and showing a session opens it, which rewrites them. Reduced motion
 * keeps the ring and drops the beat: it stands for the same time and goes.
 */
function ringRevealed(node: HTMLElement): void {
  const card = node.firstElementChild;
  if (!(card instanceof HTMLElement) || typeof card.animate !== "function") return;
  const ink = getComputedStyle(card).getPropertyValue("--primary").trim() || "currentColor";
  const edge = { outlineStyle: "solid", outlineWidth: "2px", outlineOffset: "-2px" };
  const on = { ...edge, outlineColor: ink };
  const off = { ...edge, outlineColor: "transparent" };
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const frames = still
    ? [
        { ...on, offset: 0 },
        { ...on, offset: 0.9 },
        { ...off, offset: 1 },
      ]
    : [
        { ...off, offset: 0 },
        { ...on, offset: 0.12 },
        { ...off, offset: 0.4 },
        { ...on, offset: 0.55 },
        { ...off, offset: 1 },
      ];
  card.animate(frames, { duration: RING_MS, delay: RING_DELAY_MS, easing: "ease-out" });
}
