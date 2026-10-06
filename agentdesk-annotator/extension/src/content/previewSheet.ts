/* The one stylesheet every previewed change is drawn with.
 *
 * A change is a rule keyed by the element's selector rather than an inline style on the element: a
 * page that re-renders the element (React, a hot reload) keeps showing the change, a draft can be
 * drawn again on a fresh page load, and taking it away is removing a rule rather than undoing an
 * edit to the page's own markup.
 *
 * The rules sit in a cascade layer declared before anything else in the document. Among
 * `!important` declarations an earlier layer outranks every later layer and every unlayered rule,
 * whatever their specificity, so a page's more specific selector does not quietly win. What still
 * beats a preview is an inline `style="... !important"` on the element itself.
 *
 * Rules are built through the CSSOM, never as text: a selector that is not exactly one valid
 * selector is refused by `insertRule` and reported, and a value set through `setProperty` cannot
 * carry another declaration. */
import type { StyleProperty } from "../../../shared/vocab.ts";

const LAYER = "agentdesk-annotator-preview";
const SHEET_ID = "__agentdesk_annotator_preview";

export interface PreviewRule {
  selector: string;
  property: StyleProperty;
  value: string;
}

export interface PreviewSheet {
  /** Draws exactly these rules in place of whatever was drawn. Returns the selectors the page refused. */
  draw(rules: PreviewRule[]): string[];
  /** Shows or hides every rule at once, to compare with the page as its code has it. */
  setShown(shown: boolean): void;
  /** Runs `read` with only these rules drawn, then draws the previous set again. */
  measureWith<T>(rules: PreviewRule[], read: () => T): T;
}

export function createPreviewSheet(): PreviewSheet {
  let style: HTMLStyleElement | null = null;
  let drawn: PreviewRule[] = [];
  let shown = true;

  /** The sheet, put back first in the document if the page removed it. */
  function sheet(): CSSStyleSheet {
    if (!style?.isConnected || !style.sheet) {
      style = document.createElement("style");
      style.id = SHEET_ID;
      style.setAttribute("data-ax-ui", "1");
      const parent = document.head ?? document.documentElement;
      parent.insertBefore(style, parent.firstChild);
    }
    const s = style.sheet!;
    s.disabled = !shown;
    return s;
  }

  function write(rules: PreviewRule[]): string[] {
    const s = sheet();
    while (s.cssRules.length > 0) s.deleteRule(0);
    if (rules.length === 0) return [];
    s.insertRule(`@layer ${LAYER} {}`, 0);
    const layer = s.cssRules[0] as CSSLayerBlockRule;
    const refused: string[] = [];
    for (const rule of rules) {
      try {
        const at = layer.insertRule(`${rule.selector} {}`, layer.cssRules.length);
        (layer.cssRules[at] as CSSStyleRule).style.setProperty(rule.property, rule.value, "important");
      } catch {
        refused.push(rule.selector);
      }
    }
    return refused;
  }

  return {
    draw(rules) {
      drawn = rules;
      return write(rules);
    },
    setShown(on) {
      shown = on;
      sheet();
    },
    measureWith(rules, read) {
      const wasShown = shown;
      shown = true;
      write(rules);
      try {
        return read();
      } finally {
        shown = wasShown;
        write(drawn);
      }
    },
  };
}
