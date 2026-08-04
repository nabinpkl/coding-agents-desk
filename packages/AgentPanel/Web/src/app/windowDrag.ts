/**
 * Marks an element whose inert background drags the native window, the way a platform title bar
 * does. Applied to whichever header currently owns the window's top edge.
 */
export const WINDOW_DRAG_ATTRIBUTE = "data-window-drag";

/** Opts a subtree inside a drag region back out, for chrome that is neither a control nor inert. */
export const WINDOW_NO_DRAG_ATTRIBUTE = "data-window-no-drag";

/**
 * What counts as a control rather than title-bar background.
 *
 * Deliberately a capability list and not a list of this header's current buttons: the title bar
 * gains and loses controls with the selected thread, so enumerating them here would mean a new
 * control silently becomes undraggable-and-unclickable until someone remembered this file.
 */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='slider']",
  "[contenteditable='']",
  "[contenteditable='true']",
  `[${WINDOW_NO_DRAG_ATTRIBUTE}]`,
].join(",");

declare global {
  interface Window {
    /**
     * Installed by the macOS host's window-chrome user script. Absent on iOS and in a plain
     * browser, which is the whole platform check: no window to drag, no entry point.
     */
    __agentDeskBeginWindowDrag?: () => void;
  }
}

/** Whether a mouse-down on `target` landed on title-bar background rather than on a control. */
export function isWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const region = target.closest(`[${WINDOW_DRAG_ATTRIBUTE}]`);
  if (!region) return false;
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  // `closest` keeps walking past the region, so an interactive ancestor of the whole header would
  // otherwise veto a drag that is legitimately over background.
  return interactive === null || !region.contains(interactive);
}

/**
 * Hands inert title-bar presses to the native window.
 *
 * Capture phase, because a control that stops propagation must not also be able to suppress the
 * drag decision for the background around it.
 */
export function installWindowDrag(target: Document = document): { remove(): void } {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const beginWindowDrag = window.__agentDeskBeginWindowDrag;
    if (!beginWindowDrag) return;
    if (!isWindowDragTarget(event.target)) return;
    // The window owns this gesture now, so WebKit must not also start a selection or image drag.
    event.preventDefault();
    beginWindowDrag();
  };
  target.addEventListener("mousedown", onMouseDown, true);
  return {
    remove: () => target.removeEventListener("mousedown", onMouseDown, true),
  };
}
