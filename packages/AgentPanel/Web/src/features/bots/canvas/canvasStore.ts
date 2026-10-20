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
const RING_MS = 2000;
const RING_DELAY_MS = 250;

/**
 * Three beats of a ring in the session's Bot colour on the card's rounded box, then nothing.
 *
 * The colour is the Bot's rail, the bar down the card's leading edge, so the ring reads as that
 * card lighting up rather than as a focus mark laid over it; a theme-grey ring was too quiet to
 * find on a busy canvas. A card with no Bot colour takes the theme's primary instead.
 *
 * An outline, drawn just inside the card's edge: it takes no room, so nothing beside the card moves,
 * and the Bot card that clips whatever hangs past its sessions cannot cut it off. A halo outside it
 * (a shadow, which takes no room either) carries the colour into the gap between cards, where the
 * clip allows. Animated here rather than by a class, because the card's classes are React's and
 * showing a session opens it, which rewrites them. Reduced motion keeps the ring and drops the
 * beat: it stands for the same time and goes.
 */
function ringRevealed(node: HTMLElement): void {
  const card = node.firstElementChild;
  if (!(card instanceof HTMLElement) || typeof card.animate !== "function") return;
  const { ink, halo } = ringColours(getComputedStyle(card));
  const edge = { outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "-3px" };
  const on = { ...edge, outlineColor: ink, boxShadow: `0 0 0 4px ${halo}` };
  const off = { ...edge, outlineColor: "transparent", boxShadow: "0 0 0 4px transparent" };
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const frames = still
    ? [
        { ...on, offset: 0 },
        { ...on, offset: 0.9 },
        { ...off, offset: 1 },
      ]
    : [
        { ...off, offset: 0 },
        { ...on, offset: 0.08 },
        { ...on, offset: 0.2 },
        { ...off, offset: 0.32 },
        { ...on, offset: 0.42 },
        { ...on, offset: 0.54 },
        { ...off, offset: 0.66 },
        { ...on, offset: 0.76 },
        { ...off, offset: 1 },
      ];
  card.animate(frames, { duration: RING_MS, delay: RING_DELAY_MS, easing: "ease-in-out" });
}

/** The Bot's rail colour and a see-through step of it, or the theme's primary where there is no Bot hue. */
function ringColours(style: CSSStyleDeclaration): { ink: string; halo: string } {
  const hue = style.getPropertyValue("--bot-hue").trim();
  const lightness = style.getPropertyValue("--bot-rail-l").trim();
  const chroma = style.getPropertyValue("--bot-rail-c").trim();
  if (hue && lightness && chroma) {
    return { ink: `oklch(${lightness} ${chroma} ${hue})`, halo: `oklch(${lightness} ${chroma} ${hue} / 0.35)` };
  }
  const primary = style.getPropertyValue("--primary").trim() || "currentColor";
  return { ink: primary, halo: `color-mix(in oklch, ${primary} 35%, transparent)` };
}
