// A listener on something outside React -- the window, the document, an element -- attached while
// the component is mounted and the target exists, and moved when the target changes. The handler
// always sees the latest render, so it never needs to be in a dependency list.
//
// Pass an element held as state rather than a ref wherever the target can mount after the
// component does, or be replaced: a ref is read once, when the effect runs, and one still empty
// then is never attached, silently ("Attach to an element when it arrives", the panel's AGENTS.md).

import { useEffect, useEffectEvent, type RefObject } from "react";

/** A target, a ref to one, or nothing (which attaches nothing). */
export type ListenerTarget = EventTarget | RefObject<EventTarget | null> | null | undefined;

function resolve(target: ListenerTarget): EventTarget | null {
  if (!target) return null;
  if ("current" in target) return target.current;
  return target;
}

export function useEventListener<E extends Event = Event>(
  target: ListenerTarget,
  type: string,
  handler: (event: E) => void,
  options?: { capture?: boolean; passive?: boolean },
): void {
  const handle = useEffectEvent((event: Event) => handler(event as E));
  const capture = options?.capture ?? false;
  const passive = options?.passive;
  useEffect(() => {
    const node = resolve(target);
    if (!node) return;
    const listener = (event: Event) => handle(event);
    node.addEventListener(type, listener, { capture, passive });
    return () => node.removeEventListener(type, listener, { capture });
  }, [target, type, capture, passive]);
}
