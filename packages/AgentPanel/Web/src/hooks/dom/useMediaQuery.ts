// Whether a media query matches, from the query list's own `change` event. Read through
// `matchMedia` at each call rather than once, so a test that swaps `matchMedia` is read.

import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(queryText: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const query = globalThis.matchMedia?.(queryText);
      if (!query) return () => {};
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    [queryText],
  );
  const read = () => globalThis.matchMedia?.(queryText).matches ?? false;
  return useSyncExternalStore(subscribe, read, () => false);
}
