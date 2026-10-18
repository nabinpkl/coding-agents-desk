import { useState } from "react";
import { useInterval } from "@/hooks/useInterval";

// Claude Code's "letter-by-letter" stream is a client-side reveal of the same
// per-frame deltas we already replay. Our panel painted each delta whole, so a
// phrase-sized delta jumped the row at once and read as an unreadable chunk.
// This reveals new characters over a bounded window so the stream reads like it
// types, and snaps to full the moment the block completes.

const TICK_MS = 33;
const MAX_CATCH_UP_TICKS = 24;
const MIN_STEP = 3;

/**
 * How far back a trim will reach to hide an unterminated marker.
 *
 * Bounded because an unmatched `**` two paragraphs back is a literal asterisk, not a
 * closer that is still coming, and hiding everything after it would stall the reveal
 * for the rest of the message.
 */
const MAX_TRIM = 200;

/**
 * The largest prefix of `text` that renders as Markdown without showing a marker
 * whose closer has not arrived yet.
 *
 * The reveal hands the renderer a prefix of a document that is still being written, so
 * it routinely cuts inside inline syntax: `**Checking the e` puts two literal asterisks
 * on screen for a few hundred milliseconds, then they vanish. That was survivable while
 * only prose revealed. It is not survivable for reasoning, which conventionally OPENS
 * with a bolded topic line -- so every trace would start by showing its own markup.
 *
 * Trimming rather than parsing: the reveal already hides characters, so moving its
 * boundary back to somewhere that renders cleanly is the same operation, not a new one.
 * Handles the two markers that actually appear mid-word (`**` and inline code) and
 * leaves single `*` alone, because a line-leading `*` is a list bullet and cutting at
 * one would hide the item instead of its marker.
 */
export function markdownSafePrefix(text: string): string {
  // A marker run at the very end has no content after it yet, so nothing is lost by
  // waiting -- and this alone covers the first frame of every emphasized span.
  let safe = text.replace(/[*_~`]+$/, "");
  const trimAt = (marker: string): void => {
    const opened = safe.split(marker).length - 1;
    if (opened % 2 === 0) return;
    const at = safe.lastIndexOf(marker);
    if (at >= 0 && safe.length - at <= MAX_TRIM) safe = safe.slice(0, at);
  };
  trimAt("**");
  // Skipped when a fence is open: marked closes a dangling ``` at the end of the
  // document and renders the block, which is already stable, and counting single
  // backticks across fence markers would cut in the middle of one.
  if (!safe.includes("```")) trimAt("`");
  return safe;
}

/**
 * Returns `text`, progressively revealed toward its full length. When
 * `streaming` is true new characters appear over a bounded window; when it is
 * false the full text is returned immediately (a completed block never lingers
 * mid-reveal). Hidden state lives in refs so a fast stream of revisions keeps
 * the reveal position between re-renders instead of restarting each frame.
 *
 * Paces only. Where the boundary may LAND is `markdownSafePrefix`'s job, and its
 * caller composes the two -- so a consumer that renders plain text (a raw line, a
 * tool payload) gets the pacing without the Markdown-shaped trimming.
 */
export function useProgressiveText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState<number>(streaming ? 0 : text.length);
  // A block that stops streaming is shown whole at once, and resumes from there if it starts again.
  if (!streaming && shown !== text.length) setShown(text.length);

  // Ticks only while there is something left to reveal.
  useInterval(() => {
    setShown((current) => {
      const target = text.length;
      if (current >= target) return current;
      // A large backlog resolves in a bounded number of ticks; a small addition
      // still trickles instead of snapping. `MAX_CATCH_UP_TICKS` of 24 at
      // ~30fps means anything fills in within about three quarters of a second.
      const step = Math.max(MIN_STEP, Math.ceil((target - current) / MAX_CATCH_UP_TICKS));
      return Math.min(target, current + step);
    });
  }, streaming && shown < text.length ? TICK_MS : null);

  return streaming ? text.slice(0, shown) : text;
}