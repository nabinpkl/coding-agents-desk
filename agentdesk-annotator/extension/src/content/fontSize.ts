/* Font sizes as the preview handles them: measured from the page, held to a size a page can render,
 * and written with the two decimals the wire allows. */

const MIN_PX = 1;
const MAX_PX = 400;

export function twoDecimals(px: number): number {
  return Math.round(px * 100) / 100;
}

/** Written without trailing zeros: `14px`, `13.33px`. */
export function cssPixels(px: number): string {
  return `${twoDecimals(px)}px`;
}

export function clampFontSize(px: number): number {
  return twoDecimals(Math.min(MAX_PX, Math.max(MIN_PX, px)));
}

/** The element's computed size, or null for an element a size cannot be read or set on. */
export function computedFontSize(el: Element): number | null {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return null;
  const px = parseFloat(getComputedStyle(el).fontSize);
  return Number.isFinite(px) && px > 0 ? twoDecimals(px) : null;
}
