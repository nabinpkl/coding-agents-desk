// Whether the page is showing, from the document's own `visibilitychange`.

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const read = (): boolean => !document.hidden;

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
