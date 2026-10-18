// A subscription to something that pushes -- a sidecar stream, an event source -- held open while
// the component is mounted, and closed and opened again when `key` changes. `null` holds nothing.
//
// The key is a string on purpose: it names exactly what the subscription is to, including the
// identity of the data source it reads from (`sourceKey`), so a hot-swapped source reopens and an
// unrelated re-render does not. `open` always sees the latest render, so the values it reads never
// need listing; what it SUBSCRIBES to must be in the key.
//
// Prefer a store (`createSourceStore`, read with `useSourceStore`) when several components show the
// same stream: this holds one subscription per mounted component.

import { useEffect, useEffectEvent } from "react";

export function useSubscription(key: string | null, open: () => (() => void) | void): void {
  const start = useEffectEvent(open);
  useEffect(() => {
    if (key === null) return;
    return start();
  }, [key]);
}
