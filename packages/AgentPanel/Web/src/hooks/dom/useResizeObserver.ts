// Watches an element's size while the component is mounted and the element exists, and calls
// `onResize` once per report with the report's last entry. The callback always sees the latest
// render. The entry can be missing -- a stand-in observer under test reports nothing -- so a caller
// that needs a size reads it from the entry when there is one and from its element otherwise.
//
// Pass an element held as state rather than a ref wherever the target can mount after the
// component does, or be replaced: a ref is read once, when the effect runs, and one still empty
// then is never observed, silently ("Attach to an element when it arrives", the panel's AGENTS.md).

import { useEffect, useEffectEvent, type RefObject } from "react";

export function useResizeObserver(
  target: Element | RefObject<Element | null> | null | undefined,
  onResize: (entry: ResizeObserverEntry | undefined) => void,
): void {
  const handle = useEffectEvent(onResize);
  useEffect(() => {
    const node = target && "current" in target ? target.current : target;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries?: ResizeObserverEntry[]) => handle(entries?.at(-1)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [target]);
}
