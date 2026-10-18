// Ref callbacks for what an element needs done when it appears and disappears. React 19 runs the
// function a ref callback returns when the element leaves, so attach-and-detach work needs no
// effect. Module-level functions on purpose: a ref callback built inline is a new function every
// render, and React calls a new one again on every render.

/** Takes focus as the element appears: the thing the reader just asked for. */
export function focusOnMount(node: HTMLElement | null): void {
  node?.focus();
}

/** Takes focus and selects its text as the field appears, so typing replaces what was there. */
export function selectOnMount(node: HTMLInputElement | HTMLTextAreaElement | null): void {
  node?.focus();
  node?.select();
}

/**
 * Opens a `<dialog>` as a modal for as long as it is mounted, and closes it as it leaves. Render
 * the dialog only while it is open, and its body's state starts fresh on every opening.
 *
 * jsdom's dialog has no `showModal`; the `open` attribute is what that shows instead.
 */
export function modalWhileMounted(node: HTMLDialogElement | null): (() => void) | undefined {
  if (!node) return undefined;
  if (!node.open) {
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }
  return () => {
    if (node.open) node.close?.();
  };
}
