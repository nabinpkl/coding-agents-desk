// A ref that holds the value of the latest committed render, for code that runs outside React's
// render -- a pointer handler on a long-lived object, a callback a library keeps. Written after
// commit rather than during render, because a render React throws away must not leak its values.
//
// Committed, so not for render: a child's layout effect, or anything else that runs before this
// component's own commit finishes, still reads the previous render's value. Code that needs this
// render's value during render takes the value itself.

import { useLayoutEffect, useRef, type RefObject } from "react";

export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useCommitToRef(ref, value);
  return ref;
}

/**
 * The same, into a ref the caller already holds: for a handler that also writes the ref itself
 * (a draft that runs ahead of the render it causes), and for a value defined after the code that
 * reads it (two callbacks that each need the other).
 */
export function useCommitToRef<T>(ref: RefObject<T>, value: T): void {
  useLayoutEffect(() => {
    ref.current = value;
  });
}
