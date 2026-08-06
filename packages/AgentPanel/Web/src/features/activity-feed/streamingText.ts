import { useEffect, useRef, useState } from "react";

// Claude Code's "letter-by-letter" stream is a client-side reveal of the same
// per-frame deltas we already replay. Our panel painted each delta whole, so a
// phrase-sized delta jumped the row at once and read as an unreadable chunk.
// This reveals new characters over a bounded window so the stream reads like it
// types, and snaps to full the moment the block completes.

const TICK_MS = 33;
const MAX_CATCH_UP_TICKS = 24;
const MIN_STEP = 3;

/**
 * Returns `text`, progressively revealed toward its full length. When
 * `streaming` is true new characters appear over a bounded window; when it is
 * false the full text is returned immediately (a completed block never lingers
 * mid-reveal). Hidden state lives in refs so a fast stream of revisions keeps
 * the reveal position between re-renders instead of restarting each frame.
 */
export function useProgressiveText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState<number>(streaming ? 0 : text.length);
  const shownRef = useRef<number>(streaming ? 0 : text.length);
  const textRef = useRef<string>(text);
  textRef.current = text;

  useEffect(() => {
    if (!streaming) {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    const timer = setInterval(() => {
      const target = textRef.current.length;
      const current = shownRef.current;
      if (current >= target) {
        clearInterval(timer);
        return;
      }
      // A large backlog resolves in a bounded number of ticks; a small addition
      // still trickles instead of snapping. `MAX_CATCH_UP_TICKS` of 24 at
      // ~30fps means anything fills in within about three quarters of a second.
      const step = Math.max(MIN_STEP, Math.ceil((target - current) / MAX_CATCH_UP_TICKS));
      const next = Math.min(target, current + step);
      shownRef.current = next;
      setShown(next);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [streaming, text]);

  return text.slice(0, shown);
}