// The approved hooks: the only place in the panel's source allowed to import `useEffect` or
// `useLayoutEffect` (`.oxlintrc.json`, ADR-0146). Each one names the outside thing it keeps in
// step with React, so a component reads as what it needs rather than as how an effect gets it.
//
// This one is for setup that belongs to the component's whole life: attach on mount, detach on
// unmount. Something that must start again when a value changes is a remount (`key`), a query, or
// a store -- not this with dependencies.

import { useEffect, useEffectEvent } from "react";

/** Runs `setup` once after mount; the function it returns runs on unmount. */
export function useMountEffect(setup: () => void | (() => void)): void {
  const run = useEffectEvent(setup);
  useEffect(() => run(), []);
}

/** Runs `teardown` when the component unmounts, with the values of the last render. */
export function useUnmountEffect(teardown: () => void): void {
  const run = useEffectEvent(teardown);
  useEffect(() => () => run(), []);
}
