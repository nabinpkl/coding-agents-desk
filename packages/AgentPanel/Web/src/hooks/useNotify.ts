// Tells a parent about a value this component derives, after each commit in which it changed.
//
// The shape React's docs steer away from, kept in one named place on purpose: the parent renders a
// frame behind, and two components each holding a copy is how they drift. Prefer lifting the state
// to the parent, or moving the source both read into a store. This is for what neither is yet --
// a value derived from a stream only this component holds -- and every call to it is a candidate
// for that move.

import { useEffect, useEffectEvent } from "react";

export function useNotify<T>(value: T, notify: (value: T) => void): void {
  const tell = useEffectEvent(notify);
  useEffect(() => tell(value), [value]);
}
