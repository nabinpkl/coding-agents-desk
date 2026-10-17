// The trackpad deck's geometry, and whether this device gets one.
//
// The first five are the iPhone client's layout (`PairingViewController+Layout.swift`), checked
// against it by `swiftParity.test.ts`. The deck's height is the web's own: the Swift pad filled
// whatever its constraints left below the picture, and a browser box has no such layout to
// inherit, so it takes the share of the viewer the reader chose in Tuning
// (`deckHeightPreference.ts`), with a floor.

/** The scroll strip's width. */
export const SCROLL_STRIP_WIDTH = 60;
export const SCROLL_STRIP_RADIUS = 16;
/** Hit area past the strip's right edge, so a swipe landing in the gutter still scrolls. */
export const SCROLL_STRIP_HIT_OUTSET = 12;
/** Hit area past the pad's left edge, for the same reason on the other side. */
export const TRACKPAD_HIT_OUTSET = 12;
export const TRACKPAD_STRIP_GAP = 8;

/** The shortest deck that still leaves a pad worth dragging on and room for its button row. */
export const TRACKPAD_DECK_MIN_HEIGHT = 120;

export const TRACKPAD_DECK_STORAGE_KEY = "agentdesk.desktop.trackpadDeck";

/** How tall the deck is in a viewer this tall, at this share of it. */
export function trackpadDeckHeight(viewerHeight: number, share: number): number {
  return Math.round(Math.max(TRACKPAD_DECK_MIN_HEIGHT, viewerHeight * share));
}

/**
 * Whether the deck is offered at all: only where the primary pointer is a finger.
 *
 * A mouse already has a position on the picture to point with (Follow), so a pad under it would
 * be a slower copy of the hand on the desk. Read once per mount; a device does not change what
 * its primary pointer is while a page is open.
 */
export function primaryPointerIsTouch(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export function storedTrackpadDeck(): boolean {
  try {
    return window.localStorage.getItem(TRACKPAD_DECK_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeTrackpadDeck(shown: boolean): void {
  try {
    window.localStorage.setItem(TRACKPAD_DECK_STORAGE_KEY, String(shown));
  } catch {
    // A private window still gets the deck for this session.
  }
}
