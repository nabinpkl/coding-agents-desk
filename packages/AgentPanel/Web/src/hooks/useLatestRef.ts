// A ref that holds the value of the latest committed render, for code that runs outside React's
// render -- a pointer handler on a long-lived object, a callback a library keeps. Written after
// commit rather than during render, because a render React throws away must not leak its values.

import { useLayoutEffect, useRef, type RefObject } from "react";

export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
