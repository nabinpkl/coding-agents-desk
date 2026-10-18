// A write to the DOM that has to wait until React has drawn: a scroll position, a selection, a
// size read off one element and written onto another. Runs after layout and before paint, so the
// reader never sees the frame in between.
//
// DOM writes only. Not state (compute it in render, or `useStateFor`), not a fetch (a query), not
// a subscription (a store or `useEventListener`): those each have a home that says what they are,
// and a call to this that does one of them is the effect the ban exists to stop, renamed.
// `deps` are the values the write reads.

import { useLayoutEffect, type DependencyList } from "react";

export function useDomSync(write: () => void | (() => void), deps: DependencyList): void {
  // The caller's deps are this hook's deps by contract; the rule cannot see through the wrapper.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(write, deps);
}
