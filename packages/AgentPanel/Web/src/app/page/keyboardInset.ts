import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import {
  bringsOwnKeys,
  hasOwnKeyRow,
  KEYBOARD_BAR_HEIGHT,
  KEYBOARD_SUGGESTION_ATTRIBUTE,
  publishKeyboardBar,
} from "@/features/keyboard/keyboardBarState";

/** Below this, a shrunken visual viewport is browser chrome or rounding, not a keyboard. */
const MINIMUM_KEYBOARD_INSET = 60;

/** Past this the reader has pinched in, and the page is theirs to pan rather than ours to move. */
const ZOOMED_SCALE = 1.01;

const INSET_PROPERTY = "--agent-panel-keyboard-inset";

/** On the document element while a keyboard is up, for what should step aside while typing. */
const RAISED_ATTRIBUTE = "data-keyboard-up";

/** Whether this element is the kind a phone raises its keyboard for. */
export function typesText(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

/**
 * How much of the layout viewport an on-screen keyboard is covering.
 *
 * A phone keyboard shrinks the VISUAL viewport and leaves the layout viewport where it was, so a
 * shell sized to the layout viewport keeps its bottom -- the composer, and the terminal above it --
 * underneath the keyboard the user just raised by tapping that terminal. The difference between
 * the two viewports is the covered strip, and giving it back is what lifts the content.
 *
 * Measured against `innerHeight` rather than the document element's own height, because this inset
 * is what shortens the document: reading the result back in would feed into itself.
 *
 * Gated on a focused text field, because a pinch-zoom shrinks the visual viewport the same way and
 * means the opposite -- there the hidden strip is one the reader panned away from deliberately,
 * and shortening the page underneath them would fight the gesture.
 */
export function keyboardInset(reading: {
  layoutHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
  typing: boolean;
  /** The visual viewport's zoom; a reader zoomed in is left where they panned to. */
  scale?: number;
  /** The keyboard bar's height while it stands on the keyboard, which the page clears as well. */
  bar?: number;
}): number {
  if (!reading.typing || (reading.scale ?? 1) > ZOOMED_SCALE) return 0;
  const covered = reading.layoutHeight - (reading.viewportHeight + reading.viewportOffsetTop);
  return covered >= MINIMUM_KEYBOARD_INSET ? Math.round(covered) + (reading.bar ?? 0) : 0;
}

/**
 * Whether the keyboard bar stands on the keyboard: a text field is focused on a device that draws
 * its keyboard, and the field's region has no key row of its own.
 *
 * Shown once the keyboard has measurably arrived, so the page moves once for both rather than
 * twice. Zoomed in, the covered strip cannot be told from the zoom, so a focused field is taken to
 * mean the keyboard is up.
 */
export function showsKeyboardBar(reading: {
  typing: boolean;
  drawsKeyboard: boolean;
  ownKeyRow: boolean;
  covered: number;
  scale: number;
}): boolean {
  if (!reading.typing || !reading.drawsKeyboard || reading.ownKeyRow) return false;
  return reading.scale > ZOOMED_SCALE || reading.covered >= MINIMUM_KEYBOARD_INSET;
}

/**
 * Publish the keyboard inset as a CSS variable, which `styles.css` subtracts from the document's
 * height, and whether there is one as an attribute, which a selector can test where a length
 * cannot. One writer, and the layout reads it -- rather than every surface that has something near
 * the bottom of the screen growing its own viewport listener. The keyboard bar is published from
 * the same reading (`features/keyboard/keyboardBarState.ts`), so it and the page move together.
 */
export function installKeyboardInset(): { remove(): void } {
  const viewport = window.visualViewport;
  // WebKit's own pinch events: the viewport's numbers trail a pinch, so the bar steps aside for it.
  let pinching = false;
  // The focused field's suggestion can change while it stays focused, and nothing else here moves.
  const suggestionWatch = new MutationObserver(() => apply());
  let watched: Element | null = null;
  let appliedInset = 0;
  const apply = (): void => {
    const active = document.activeElement;
    const typing = typesText(active);
    const layoutHeight = window.innerHeight;
    const viewportHeight = viewport?.height ?? layoutHeight;
    const viewportOffsetTop = viewport?.offsetTop ?? 0;
    const scale = viewport?.scale ?? 1;
    const field =
      typesText(active) &&
      showsKeyboardBar({
        typing,
        drawsKeyboard: drawsOwnKeyboard(),
        ownKeyRow: hasOwnKeyRow(active),
        covered: layoutHeight - (viewportHeight + viewportOffsetTop),
        scale,
      })
        ? active
        : null;
    const inset = keyboardInset({
      layoutHeight,
      viewportHeight,
      viewportOffsetTop,
      typing,
      scale,
      bar: field ? KEYBOARD_BAR_HEIGHT : 0,
    });
    document.documentElement.style.setProperty(INSET_PROPERTY, `${inset}px`);
    document.documentElement.toggleAttribute(RAISED_ATTRIBUTE, inset > 0);
    // The browser brought the field into view when it was tapped, before the keyboard and the bar
    // said how much they cover; whatever it sits in has shrunk since, so it is brought in again. A
    // layout is forced by the scroll, so it measures against the height just set.
    if (inset !== appliedInset && inset > 0 && typesText(active)) bringIntoSight(active);
    appliedInset = inset;
    if (watched !== field) {
      suggestionWatch.disconnect();
      watched = field;
      if (watched) suggestionWatch.observe(watched, { attributeFilter: [KEYBOARD_SUGGESTION_ATTRIBUTE] });
    }
    publishKeyboardBar(
      field
        ? {
            field,
            host: field.closest<HTMLElement>("dialog[open]") ?? document.body,
            viewport: {
              left: viewport?.offsetLeft ?? 0,
              bottom: viewportOffsetTop + viewportHeight,
              width: viewport?.width ?? window.innerWidth,
              scale,
            },
            pinching,
            suggestion: field.getAttribute(KEYBOARD_SUGGESTION_ATTRIBUTE),
            ownKeys: bringsOwnKeys(field),
          }
        : null,
    );
  };
  const pinchStarts = (): void => {
    pinching = true;
    apply();
  };
  const pinchEnds = (): void => {
    pinching = false;
    apply();
  };
  // `scroll` as well as `resize`: iOS pans the visual viewport to keep the caret in sight, which
  // moves the covered strip without changing its size.
  viewport?.addEventListener("resize", apply);
  viewport?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  // The viewport events say how much is covered; these say whether anything is typing into it, and
  // blur usually lands before the viewport has finished growing back.
  document.addEventListener("focusin", apply);
  document.addEventListener("focusout", apply);
  document.addEventListener("gesturestart", pinchStarts);
  document.addEventListener("gestureend", pinchEnds);
  apply();
  return {
    remove: () => {
      viewport?.removeEventListener("resize", apply);
      viewport?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", apply);
      document.removeEventListener("gesturestart", pinchStarts);
      document.removeEventListener("gestureend", pinchEnds);
      suggestionWatch.disconnect();
      publishKeyboardBar(null);
      document.documentElement.style.removeProperty(INSET_PROPERTY);
      document.documentElement.removeAttribute(RAISED_ATTRIBUTE);
    },
  };
}

/**
 * Marks a region to keep in sight as a whole while a field inside it is typed into.
 *
 * A terminal is typed into through xterm's hidden one-line field, so bringing that field into view
 * left the screen above it and the key rail below it under the keyboard.
 */
export const KEEP_IN_SIGHT_ATTRIBUTE = "data-keep-in-sight";

/**
 * Keep the field being typed into in sight whenever `scroller` gets shorter.
 *
 * Shortening the document lifts whatever sits at the bottom of a scroller that fits it, but not a
 * field partway down a scroller with more under it -- a column with a floor under its height
 * leaves its lower fields beneath the keyboard, and a Canvas card has a fixed height, so the
 * Canvas shrinking moved none of it. The browser scrolled the field into view on focus, before the
 * keyboard said how much it covers, so this does it again once the scroller has shrunk: a resize
 * of the box itself rather than another viewport listener, so it runs after the inset has been
 * laid out. Only a field inside `scroller`, and only as far as it takes; the region around it
 * when one is marked (`KEEP_IN_SIGHT_ATTRIBUTE`).
 */
/** `keepTypingInSight` for as long as `scroller` is mounted, as a ref callback. */
export function keepTypingInSightWhileMounted(scroller: HTMLElement | null): (() => void) | undefined {
  if (!scroller) return undefined;
  const keeping = keepTypingInSight(scroller);
  return () => keeping.remove();
}

/** Scrolls a focused field into view, or the marked region around it, only as far as it takes. */
function bringIntoSight(field: HTMLElement, within?: HTMLElement): void {
  const region = field.closest<HTMLElement>(`[${KEEP_IN_SIGHT_ATTRIBUTE}]`);
  (region && (!within || within.contains(region)) ? region : field).scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
}

export function keepTypingInSight(scroller: HTMLElement): { remove(): void } {
  const observer = new ResizeObserver(() => {
    const active = document.activeElement;
    if (!typesText(active) || !scroller.contains(active)) return;
    bringIntoSight(active, scroller);
  });
  observer.observe(scroller);
  return { remove: () => observer.disconnect() };
}
