// Watches an element's size while the component is mounted and the element exists. The callback
// always sees the latest render.

import { useEffect, useEffectEvent, type RefObject } from "react";

export function useResizeObserver(
  target: Element | RefObject<Element | null> | null | undefined,
  onResize: (entry: ResizeObserverEntry) => void,
): void {
  const handle = useEffectEvent(onResize);
  useEffect(() => {
    const node = target && "current" in target ? target.current : target;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) handle(entry);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [target]);
}
