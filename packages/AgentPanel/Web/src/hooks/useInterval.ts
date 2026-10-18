// Timers that belong to a component: started while it is mounted, cleared when it unmounts or
// when `ms` becomes null. The callback always sees the latest render.

import { useEffect, useEffectEvent } from "react";

/** Calls `tick` every `ms` milliseconds; `null` stops it. */
export function useInterval(tick: () => void, ms: number | null): void {
  const run = useEffectEvent(tick);
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => run(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * Calls `fire` once, `ms` milliseconds after the component mounts or after `restartKey` last
 * changed; `ms === null` cancels it.
 */
export function useTimeout(fire: () => void, ms: number | null, restartKey?: unknown): void {
  const run = useEffectEvent(fire);
  useEffect(() => {
    if (ms === null) return;
    const id = setTimeout(() => run(), ms);
    return () => clearTimeout(id);
  }, [ms, restartKey]);
}
