/** Below this, a shrunken visual viewport is browser chrome or rounding, not a keyboard. */
const MINIMUM_KEYBOARD_INSET = 60;

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
}): number {
  if (!reading.typing) return 0;
  const covered = reading.layoutHeight - (reading.viewportHeight + reading.viewportOffsetTop);
  return covered >= MINIMUM_KEYBOARD_INSET ? Math.round(covered) : 0;
}

/**
 * Publish the keyboard inset as a CSS variable, which `styles.css` subtracts from the document's
 * height, and whether there is one as an attribute, which a selector can test where a length
 * cannot. One writer, and the layout reads it -- rather than every surface that has something near
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
    document.documentElement.toggleAttribute(RAISED_ATTRIBUTE, inset > 0);
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
      document.documentElement.removeAttribute(RAISED_ATTRIBUTE);
    },
  };
}

/**
 * Keep the field being typed into in sight whenever `scroller` gets shorter.
 *
 * Shortening the document lifts whatever sits at the bottom of a scroller that fits it, but not a
 * field partway down a scroller with more under it -- a column with a floor under its height
 * leaves its lower fields beneath the keyboard. The browser scrolled the field into view on focus,
 * before the keyboard said how much it covers, so this does it again once the scroller has shrunk:
 * a resize of the box itself rather than another viewport listener, so it runs after the inset has
 * been laid out. Only a field inside `scroller`, and only as far as it takes.
 */
export function keepTypingInSight(scroller: HTMLElement): { remove(): void } {
  const observer = new ResizeObserver(() => {
    const active = document.activeElement;
    if (typesText(active) && scroller.contains(active)) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  observer.observe(scroller);
  return { remove: () => observer.disconnect() };
}
