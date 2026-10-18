// The time now, for a surface that shows an age or a countdown.
//
// Held as state rather than read with `Date.now()` while rendering, because a render must give the
// same answer each time React runs it: a clock read in render is the one value a memoized component
// would never ask for again. It is read afresh whenever `scope` changes -- the data the age is
// about -- and then every `tickMs` while that is not null. A tick is the honest shape here: nothing
// can say that time has passed, so the clock is asked, and only as often as the label can change.

import { useInterval } from "@/hooks/useInterval";
import { useStateFor } from "@/hooks/state/useStateFor";

export function useNow(scope: unknown, tickMs: number | null = null): number {
  const [now, setNow] = useStateFor(scope, () => Date.now());
  useInterval(() => setNow(Date.now()), tickMs);
  return now;
}
