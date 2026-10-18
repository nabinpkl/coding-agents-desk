// State that belongs to one value of something else -- the menu open for this workspace, the row
// highlighted for this query -- and starts again from `initial` when that value changes.
//
// The reset happens during the render that sees the new value, which React supports for a
// component's own state: it re-renders at once, before anything is drawn. An effect resetting it
// would draw one frame of the old value under the new one first, and then render everything again.
// When the whole component belongs to the value, a `key` on it says this more simply; this is for
// when only part of it does.

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export function useStateFor<T>(scope: unknown, initial: () => T): [T, Dispatch<SetStateAction<T>>] {
  const [held, setHeld] = useState(() => ({ scope, value: initial() }));
  let current = held;
  if (!Object.is(held.scope, scope)) {
    current = { scope, value: initial() };
    setHeld(current);
  }
  const set = useCallback((next: SetStateAction<T>) => {
    setHeld((previous) => ({
      scope: previous.scope,
      value: typeof next === "function" ? (next as (value: T) => T)(previous.value) : next,
    }));
  }, []);
  return [current.value, set];
}
