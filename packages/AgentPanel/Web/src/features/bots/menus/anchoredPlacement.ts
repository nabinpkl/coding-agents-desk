// Placing a popup that lives in `document.body` against the control that opened it.
//
// A popup inside a canvas card is cut off by the card, because every card sets `overflow-hidden`
// to keep its content inside its rounded corners. So the row menus and the task popover render
// into the body, positioned `fixed`, and these two answer what that takes away: where to put the
// popup, measured against the window, and whether the control it belongs to is still on screen.

/** The gap a popup keeps between itself and the edge of the window. */
const MARGIN = 8;
/** The gap between the trigger and the popup. */
const GAP = 4;

/** Where an open popup sits, in viewport coordinates, because it is positioned `fixed`. */
export interface Placement {
  top: number;
  left: number;
}

/** The overflow values that clip a child, named rather than everything-but-`visible`. */
function clips(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
}

/**
 * Whether the trigger is still inside every ancestor that clips it.
 *
 * The one thing portalling takes away and has to be given back. A popup inside the card was cut off
 * with the card, which was the bug -- but it also disappeared with it. One in `document.body` has
 * no such relationship, so scrolling the trigger under a card header or off the strip leaves the
 * popup floating over content it has nothing to do with. This is the cheap version of what a
 * floating-element library calls `hide`: a rect test per clipping ancestor, run only while a popup
 * is open, on a list that is a handful of nodes deep.
 */
export function triggerIsVisible(button: HTMLElement): boolean {
  const rect = button.getBoundingClientRect();
  for (let node = button.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    // `getComputedStyle` answers with an empty string for a property nothing has set in some
    // engines, so this asks for the clipping values by name: treating the empty string as a
    // clipper would make the nearest wrapper a boundary and close every popup on sight.
    if (!clips(style.overflowY) && !clips(style.overflowX)) continue;
    // Strictly outside, so a row resting exactly on a boundary counts as visible. Touching edges
    // are what degenerate rects produce -- a hidden tab, a row mid-measure -- and closing a popup
    // because two zeroes compared equal would be this check inventing its own failure.
    const box = node.getBoundingClientRect();
    if (rect.bottom < box.top || rect.top > box.bottom) return false;
    if (rect.right < box.left || rect.left > box.right) return false;
  }
  return true;
}

/**
 * Where to put an open popup, measured against the WINDOW rather than against anything it is in.
 *
 * Below the trigger by default, aligned to its `end` (right) edge for a menu and its `start` edge
 * for a popover that reads on from the text it opened from. Upward when the window has no room
 * below and more above, and clamped on both axes so a trigger at any edge still gets a popup that
 * is entirely on screen.
 */
export function placePopup(trigger: DOMRect, popup: DOMRect, align: "start" | "end" = "end"): Placement {
  const viewportHeight = globalThis.innerHeight || 0;
  const viewportWidth = globalThis.innerWidth || 0;
  const below = viewportHeight - trigger.bottom - MARGIN;
  const above = trigger.top - MARGIN;
  const upward = popup.height > below && above > below;
  const top = upward ? trigger.top - GAP - popup.height : trigger.bottom + GAP;
  const left = align === "end" ? trigger.right - popup.width : trigger.left;
  // The clamps are what make "neither side fits" a popup with its top edge on screen rather than a
  // popup with nothing on screen. `Math.max` last, so a popup taller than the window starts at the
  // top instead of being pushed off it.
  return {
    top: Math.max(MARGIN, Math.min(top, viewportHeight - MARGIN - popup.height)),
    left: Math.max(MARGIN, Math.min(left, viewportWidth - MARGIN - popup.width)),
  };
}
