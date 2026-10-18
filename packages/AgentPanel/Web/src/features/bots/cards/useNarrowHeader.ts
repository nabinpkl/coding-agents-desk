// Whether a Bot card's header has room for the controls it would rather not lose.
//
// A card is exactly as wide as the sessions standing in it, so a Bot with one short-named session
// card is narrow while its neighbour with six is not -- on the same strip, at the same window
// width, on the same canvas. That is why this measures the element rather than the window: a media
// query would answer "the panel is wide" for both cards and hand the narrow one the same header it
// cannot fit. The session card already measures itself the same way, in CSS (`BotSessionCard`'s
// `@container`).

import { useState, type RefObject } from "react";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useResizeObserver } from "@/hooks/dom/useResizeObserver";

/**
 * The width below which the code, git and terminal controls move into the more menu.
 *
 * Measured from the live canvas rather than guessed. A header carries 44px of face, three 36px
 * slots, a 36px add button, a 32px menu, 16px of its own padding and a 12px gap between each pair
 * of neighbours: 311px of chrome with a git count in the row, 164px without the three. So above the
 * line the width is spent on those three, and below it on the name. A card of 420 leaves about
 * 110px of name, which is a name a reader recognises; a card of 347 -- what a Bot with one
 * short-named session measures -- left 36px of name and one visible character, and now leaves 183.
 *
 * The switch is a cliff by nature -- the last few pixels either side of it are spent differently --
 * so it sits where the crowded side is still usable rather than in the middle of the range: a card
 * 421 wide still truncates its name, which is the behaviour that prompted the threshold.
 */
export const NARROW_HEADER_PX = 420;

/**
 * `true` while the element is narrower than `at`, measured on mount and on every resize after.
 *
 * Unmeasured is not narrow. A card in a hidden tab has no width, and a card measured at zero in a
 * test runner has none either; treating that as narrow would strip a row's controls on the strength
 * of not knowing, and the first correction would arrive as a visible jump. So the row starts whole
 * and a real measurement is what moves it.
 */
export function useNarrowHeader(
  header: RefObject<HTMLElement | null>,
  at: number = NARROW_HEADER_PX,
): boolean {
  const [narrow, setNarrow] = useState(false);
  // Measured before paint: the first measurement lands before the frame that would show the
  // crowded row, so a narrow card never appears to have a one-character name for a frame.
  const measure = (): void => {
    const width = header.current?.getBoundingClientRect().width ?? 0;
    setNarrow(width > 0 && width < at);
  };
  useDomSync(measure, [header, at]);
  useResizeObserver(header, measure);
  return narrow;
}
