// Work on the DOM that has to wait until React has drawn and must land before paint: a scroll
// position, a selection, a size read off one element and written onto another, or a measurement
// of layout kept in state (React re-renders before the frame is shown, so the reader never sees
// the unmeasured one).
//
// DOM work only. Not state derived from props (compute it in render, or `useStateFor`), not a
// fetch (a query), not a subscription (a store, `useSubscription` or `useEventListener`): each of
// those has a home that says what it is, and a call to this doing one of them is the effect the
// ban exists to stop, renamed. `deps` are the values the work reads; leaving them out runs it after
// every commit, for work whose inputs are layout rather than values (a row measured, a sizer
// resized), and which costs nothing once the answer stops changing.

import { useLayoutEffect, type DependencyList } from "react";

export function useDomSync(work: () => void | (() => void), deps?: DependencyList): void {
  // The caller's deps are this hook's deps by contract; the rule cannot see through the wrapper.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(work, deps);
}
