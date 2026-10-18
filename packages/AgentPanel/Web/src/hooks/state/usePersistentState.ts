// State that is also written to storage, from one place: the setter this returns. Every change goes
// through it, so no caller can forget the write, and there is no effect watching the value to do
// it a render late. `store` must be safe to call twice with the same value -- React may run an
// updater twice in development -- which every `store*` function in the panel is: it writes a key.

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export function usePersistentState<T>(
  load: T | (() => T),
  store: (value: T) => void,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(load);
  const update = useCallback(
    (next: SetStateAction<T>) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
        if (!Object.is(resolved, current)) store(resolved);
        return resolved;
      });
    },
    [store],
  );
  return [value, update];
}
