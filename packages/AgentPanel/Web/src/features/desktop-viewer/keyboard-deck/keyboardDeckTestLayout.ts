import { PORTRAIT_DECK, type KeyboardDeckMetrics } from "@/features/desktop-viewer/keyboard-deck/keyboardDeckMetrics";

/**
 * Give a rendered deck the geometry a browser would have laid out.
 *
 * The deck resolves every touch by coordinates, so a test that drives it needs real rectangles and
 * jsdom produces none. This mirrors the CSS: keys share their row out by weight, the home row takes
 * the top row's key width and centres, and row three widens the two gaps beside shift and delete.
 * Test-only, but it lives beside the component so it moves when the layout does.
 */
export function stubDeckLayout(
  deck: HTMLElement,
  { width = 390, metrics = PORTRAIT_DECK }: { width?: number; metrics?: KeyboardDeckMetrics } = {},
): void {
  const inset = metrics.horizontalDeckInset;
  const content = width - inset * 2;
  const unit = (content - 9 * metrics.horizontalKeyGap) / 10;
  stubRect(deck, {
    left: 0,
    top: 0,
    right: width,
    bottom: metrics.deckHeight,
    width,
    height: metrics.deckHeight,
  });
  const rows = [...deck.querySelectorAll<HTMLElement>("[data-deck-row]")];
  rows.forEach((row, rowIndex) => {
    const buttons = [...row.children] as HTMLElement[];
    const top = metrics.topDeckPadding + rowIndex * (metrics.keycapHeight + metrics.verticalRowGap);
    const bottom = top + metrics.keycapHeight;
    stubRect(row, {
      left: inset,
      right: width - inset,
      top,
      bottom,
      width: content,
      height: metrics.keycapHeight,
    });
    const gaps = buttons.map((_, index) => {
      if (index === 0) return 0;
      const widened = rowIndex === 2 && (index === 1 || index === buttons.length - 1);
      return widened ? metrics.alphabetOuterKeyGap : metrics.horizontalKeyGap;
    });
    const spacing = gaps.reduce((total, gap) => total + gap, 0);
    // jsdom normalises `flex: none` to `0 0 auto`, so the shared width is the reliable marker.
    const centred = buttons[0]!.style.width === "var(--kbd-key-w)";
    const weights = buttons.map((button) => Number(button.style.flexGrow) || 0);
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    const widths = centred
      ? buttons.map(() => unit)
      : weights.map((weight) => (weight / totalWeight) * (content - spacing));
    const used = widths.reduce((total, value) => total + value, 0) + spacing;
    let x = inset + (centred ? (content - used) / 2 : 0);
    buttons.forEach((button, index) => {
      x += gaps[index]!;
      stubRect(button, {
        left: x,
        right: x + widths[index]!,
        top,
        bottom,
        width: widths[index]!,
        height: metrics.keycapHeight,
      });
      x += widths[index]!;
    });
  });
}

function stubRect(element: Element, rect: Partial<DOMRect>): void {
  element.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  });
}
