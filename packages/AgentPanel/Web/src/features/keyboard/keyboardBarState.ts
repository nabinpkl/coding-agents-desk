// What the keyboard bar shows and where, published by the one thing that already watches the
// keyboard (`app/page/keyboardInset.ts`) and read by the bar (`KeyboardBar.tsx`).
//
// The bar is a row of keys an iPhone's keyboard does not have, drawn on top of that keyboard for
// whatever text field is focused. Its state lives here rather than in the bar so the page and the
// bar move together: the same reading that shortens the page by the keyboard and the bar is the one
// that places the bar, so neither can be a frame behind the other.

/** How tall the bar stands, in screen pixels: one row of keys a thumb can hit. */
export const KEYBOARD_BAR_HEIGHT = 44;

/**
 * How tall it stands when the field brings its own keys: their arrow pad is two rows,
 * ↑ over ← ↓ →, and each row wants a key a thumb can hit.
 */
const KEYBOARD_BAR_KEYS_HEIGHT = 64;

/** The bar's height for what it is carrying. */
export function keyboardBarHeight(ownKeys: boolean): number {
  return ownKeys ? KEYBOARD_BAR_KEYS_HEIGHT : KEYBOARD_BAR_HEIGHT;
}

/**
 * Marks a region whose fields bring their own keys ONTO the bar, in place of its Esc, Tab and
 * arrows: a terminal's rail, whose keys go to a pane, and the desktop viewer's, whose go to the Mac.
 * Written `data-keyboard-bar="keys"`; the region draws its keys into the bar with `OnKeyboardBar`.
 */
const OWN_KEYS_ON_BAR = '[data-keyboard-bar="keys"]';

/**
 * On a field, the suggestion it is offering, which the bar shows as a key that takes it. Taking it
 * is the field's own Tab: the bar presses Tab, and the field already knows what that means.
 */
export const KEYBOARD_SUGGESTION_ATTRIBUTE = "data-keyboard-suggestion";

export interface KeyboardBarState {
  /** The field the keys go to, or null while the bar is not shown. */
  field: HTMLElement | null;
  /**
   * What the bar is drawn into: the modal dialog the field is in, or the body. A modal dialog makes
   * everything outside it inert, so a bar drawn outside one could be seen and not pressed.
   */
  host: HTMLElement | null;
  /** The visible part of the page, in page pixels, and how far it is zoomed in. */
  viewport: { left: number; bottom: number; width: number; scale: number };
  /** A pinch is under way, while which the viewport's numbers arrive late. */
  pinching: boolean;
  suggestion: string | null;
  /** The field brings its own keys, so the bar leaves room for them rather than drawing its own. */
  ownKeys: boolean;
  /** Where a field's own keys are drawn on the bar, set by the bar once it is on screen. */
  slot: HTMLElement | null;
}

const HIDDEN: KeyboardBarState = {
  field: null,
  host: null,
  viewport: { left: 0, bottom: 0, width: 0, scale: 1 },
  pinching: false,
  suggestion: null,
  ownKeys: false,
  slot: null,
};

let current = HIDDEN;
const listeners = new Set<() => void>();

export function keyboardBarSnapshot(): KeyboardBarState {
  return current;
}

export function subscribeKeyboardBar(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function same(left: KeyboardBarState, right: KeyboardBarState): boolean {
  return (
    left.field === right.field &&
    left.host === right.host &&
    left.pinching === right.pinching &&
    left.suggestion === right.suggestion &&
    left.ownKeys === right.ownKeys &&
    left.slot === right.slot &&
    left.viewport.left === right.viewport.left &&
    left.viewport.bottom === right.viewport.bottom &&
    left.viewport.width === right.viewport.width &&
    left.viewport.scale === right.viewport.scale
  );
}

function replace(value: KeyboardBarState): void {
  if (same(current, value)) return;
  current = value;
  for (const listener of listeners) listener();
}

/**
 * Replaces what the keyboard says, telling readers only when something they draw from changed. The
 * slot is the bar's own to say, so it is kept.
 */
export function publishKeyboardBar(next: Omit<KeyboardBarState, "slot"> | null): void {
  replace({ ...(next ?? HIDDEN), slot: current.slot });
}

/** The bar says where a field's own keys go, or that it has gone. */
export function publishKeyboardBarSlot(slot: HTMLElement | null): void {
  replace({ ...current, slot });
}

/** Whether this field sits in a region that draws its own keys onto the bar. */
export function bringsOwnKeys(field: Element): boolean {
  return field.closest(OWN_KEYS_ON_BAR) !== null;
}
