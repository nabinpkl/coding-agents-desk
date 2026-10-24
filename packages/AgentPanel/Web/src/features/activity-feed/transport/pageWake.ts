// When the page comes back: shown again after it was hidden, or back on the network.
//
// A phone that locks or switches apps suspends the page and its timers, and the connections it held
// are usually dead when it comes back, before anything has said so: on 2026-10-19 the iPhone's
// requests in the first second after waking failed, and its streams had been silent for the whole
// time it slept. Streams listen here to retry at once (`streamRetry.ts`) rather than finish a wait
// they started before the page slept.
//
// The listeners on the document are held only while something listens here, which on a panel with
// any stream open is always.

/** One return of the page. */
export interface PageWake {
  /** What brought it back. */
  readonly cause: "visible" | "online";
  /** When, in epoch milliseconds. */
  readonly at: number;
  /** How long it had been hidden: 0 for a network that came back while it showed. */
  readonly hiddenMs: number;
}

type Listener = (wake: PageWake) => void;

const listeners = new Set<Listener>();
let hiddenAt: number | null = null;
let last: PageWake | null = null;

function wake(cause: PageWake["cause"], hiddenMs: number): void {
  last = { cause, at: Date.now(), hiddenMs };
  const woken = last;
  for (const listener of [...listeners]) listener(woken);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    hiddenAt ??= Date.now();
    return;
  }
  if (hiddenAt === null) return;
  const hiddenMs = Date.now() - hiddenAt;
  hiddenAt = null;
  wake("visible", hiddenMs);
}

function onOnline(): void {
  wake("online", 0);
}

/** Calls `listener` each time the page comes back. Returns the call that stops it. */
export function onPageWake(listener: Listener): () => void {
  if (listeners.size === 0) {
    hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
  }
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onOnline);
  };
}

/** The page's latest return, or null if it has not been hidden or offline since it loaded. */
export function lastPageWake(): PageWake | null {
  return last;
}

/**
 * Whether the page went hidden and has not yet been heard coming back. Stays true until the event
 * that says it woke has been handled, so a timer that fell due while the page slept and runs first
 * still sees a page that has not woken.
 */
export function pageAsleep(): boolean {
  return hiddenAt !== null;
}

/** For tests: forget the latest return. */
export function resetPageWake(): void {
  last = null;
}
