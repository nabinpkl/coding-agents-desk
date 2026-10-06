/* A change to one picked element's font size, shown on the page while the comment form is open.
 *
 * The size is set on that element alone, as an inline `!important` style, so the page shows exactly
 * what editing that one rule would do: the element's own text and any child sized in `em`, `%` or by
 * inheritance follow it, and a child sized in `px` or `rem` does not. That is the honest preview of
 * changing one thing; scaling the children as well would show a change no single edit produces.
 *
 * The element's own inline value is remembered and put back, so closing the form leaves the page as
 * the page's code has it. Back to the attribute's very text where nothing else has touched the inline
 * style meanwhile: changing one property makes the browser re-serialize the whole attribute, and a
 * page that reads its own `style` attribute would otherwise find it rewritten. */
import type { StyleChange } from "../../../shared/annotation.ts";

const MIN_PX = 1;
const MAX_PX = 400;

/** The two decimals the wire allows for a pixel length. */
function twoDecimals(px: number): number {
  return Math.round(px * 100) / 100;
}

/** Written without trailing zeros: `14px`, `13.33px`. */
function cssPixels(px: number): string {
  return `${twoDecimals(px)}px`;
}

export interface FontSizePreview {
  /** The computed size before any change, in CSS pixels, to the wire's two decimals. */
  readonly from: number;
  /** The size on the page now, to the same two decimals. */
  current(): number;
  /** Shows `px` on the page, held to a size a page can render. */
  set(px: number): void;
  /** Puts the element's own inline font size back as it was. */
  restore(): void;
  /** What the reader changed, or null when the size is back where it started. */
  change(): StyleChange | null;
}

export function previewFontSize(el: Element): FontSizePreview | null {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return null;
  const computed = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(computed) || computed <= 0) return null;
  const from = twoDecimals(computed);
  const ownAttribute = el.getAttribute("style");
  const ownValue = el.style.getPropertyValue("font-size");
  const ownPriority = el.style.getPropertyPriority("font-size");
  let current = from;
  let touched = false;

  return {
    from,
    current: () => current,
    set(px) {
      current = twoDecimals(Math.min(MAX_PX, Math.max(MIN_PX, px)));
      touched = true;
      el.style.setProperty("font-size", cssPixels(current), "important");
    },
    restore() {
      if (!touched) return;
      if (ownValue) el.style.setProperty("font-size", ownValue, ownPriority);
      else el.style.removeProperty("font-size");
      if (el.style.cssText === serializedStyle(ownAttribute)) {
        if (ownAttribute === null) el.removeAttribute("style");
        else el.setAttribute("style", ownAttribute);
      }
      current = from;
      touched = false;
    },
    change() {
      return current === from ? null : { property: "font-size", from: cssPixels(from), to: cssPixels(current) };
    },
  };
}

/** How the browser serializes a style attribute's text, so two spellings of one style compare equal. */
function serializedStyle(attribute: string | null): string {
  const probe = document.createElement("div");
  if (attribute !== null) probe.setAttribute("style", attribute);
  return probe.style.cssText;
}
