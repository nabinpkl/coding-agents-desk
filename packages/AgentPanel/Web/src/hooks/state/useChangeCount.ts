// How many times `value` has changed identity since mount: a number to put in a query key when a
// read must run again whenever something moves -- a pushed git status, a revision -- and the thing
// itself is an object no key could hash. Counted during render, so the new key is in the same render
// that sees the change.

import { useState } from "react";

export function useChangeCount(value: unknown): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (!Object.is(seen.value, value)) {
    const next = { value, count: seen.count + 1 };
    setSeen(next);
    return next.count;
  }
  return seen.count;
}
