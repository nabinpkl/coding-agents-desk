/** Below this, a shrunken visual viewport is browser chrome or rounding, not a keyboard. */
const MINIMUM_KEYBOARD_INSET = 60;

const INSET_PROPERTY = "--agent-panel-keyboard-inset";

/** Whether this element is the kind a phone raises its keyboard for. */
export function typesText(element: Element | null): boolean {
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
}): number {
  if (!reading.typing) return 0;
  const covered = reading.layoutHeight - (reading.viewportHeight + reading.viewportOffsetTop);
  return covered >= MINIMUM_KEYBOARD_INSET ? Math.round(covered) : 0;
}

/**
 * Publish the keyboard inset as a CSS variable, which `styles.css` subtracts from the document's
 * height. One writer, and the layout reads it -- rather than every surface that has something near
 * the bottom of the screen growing its own viewport listener.
 */
export function installKeyboardInset(): { remove(): void } {
  const viewport = window.visualViewport;
  const apply = (): void => {
    const inset = keyboardInset({
      layoutHeight: window.innerHeight,
      viewportHeight: viewport?.height ?? window.innerHeight,
      viewportOffsetTop: viewport?.offsetTop ?? 0,
      typing: typesText(document.activeElement),
    });
    document.documentElement.style.setProperty(INSET_PROPERTY, `${inset}px`);
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
  apply();
  return {
    remove: () => {
      viewport?.removeEventListener("resize", apply);
      viewport?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", apply);
      document.documentElement.style.removeProperty(INSET_PROPERTY);
    },
  };
}
