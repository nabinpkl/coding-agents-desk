// What every hand-placed menu, popover and modal in the panel needs while it is open: dismissal by
// a press outside it, a placement that follows its anchor, and a `<dialog>` kept in step with an
// `open` prop. One home for each, rather than the same effect written into every overlay.

import { useEffect, useEffectEvent, useLayoutEffect, type DependencyList, type RefObject } from "react";

/**
 * While `open`, a press anywhere outside every one of `inside` calls `dismiss`. On `pointerdown`,
 * so a press that starts inside and is released outside is not a press elsewhere.
 */
export function useDismissOnOutsidePress(
  open: boolean,
  inside: readonly RefObject<Element | null>[],
  dismiss: () => void,
): void {
  const onPress = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (inside.some((ref) => ref.current?.contains(target))) return;
    dismiss();
  });
  useEffect(() => {
    if (!open) return;
    const listener = (event: PointerEvent) => onPress(event);
    document.addEventListener("pointerdown", listener);
    return () => document.removeEventListener("pointerdown", listener);
  }, [open]);
}

/**
 * While `open`, `place` runs before the first paint and again whenever the page could have moved
 * its anchor: a resize, and (unless `scroll` is false) a scroll anywhere -- in the capture phase,
 * since a scroll does not bubble and the anchor usually sits in a scroller of its own. `place`
 * learns which one asked. `deps` are anything else that changes the placement, such as the
 * overlay's own content.
 */
export function useOverlayPlacement(
  open: boolean,
  place: (cause: "open" | "scroll" | "resize") => void,
  deps: DependencyList = [],
  { scroll = true }: { scroll?: boolean } = {},
): void {
  const run = useEffectEvent(place);
  useLayoutEffect(() => {
    if (!open) return;
    run("open");
    const onScroll = () => run("scroll");
    const onResize = () => run("resize");
    if (scroll) globalThis.addEventListener?.("scroll", onScroll, true);
    globalThis.addEventListener?.("resize", onResize);
    return () => {
      if (scroll) globalThis.removeEventListener?.("scroll", onScroll, true);
      globalThis.removeEventListener?.("resize", onResize);
    };
    // `deps` are the caller's by contract; the rule cannot see through the wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scroll, ...deps]);
}

/**
 * A `<dialog>` that is always rendered, shown as a modal while `open` and closed otherwise. A
 * dialog rendered only while open takes `modalWhileMounted` as its ref instead.
 *
 * `attributeFallback` drives the `open` attribute, and the `close` event, where the element has no
 * `showModal`/`close` -- jsdom's dialog -- for a caller whose tests read either.
 */
export function useModal(
  dialog: RefObject<HTMLDialogElement | null>,
  open: boolean,
  { attributeFallback = false }: { attributeFallback?: boolean } = {},
): void {
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      if (typeof node.showModal === "function") node.showModal();
      else if (attributeFallback) node.setAttribute("open", "");
    } else if (!open && node.open) {
      if (typeof node.close === "function") node.close();
      else if (attributeFallback) {
        node.removeAttribute("open");
        node.dispatchEvent(new Event("close"));
      }
    }
  }, [dialog, open, attributeFallback]);
}
