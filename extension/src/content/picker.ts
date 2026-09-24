/* What gets recorded about the container the user clicked: a stable-enough
 * selector, a short DOM path, component hints, and a style summary. */
import type { ElementMetadata } from "../../../shared/annotation.ts";

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BUTTON", "CARD", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "INPUT",
  "LI", "MAIN", "NAV", "OL", "P", "SECTION", "SELECT", "TABLE", "TD", "TEXTAREA", "TH", "TR", "UL",
]);

/** Nearest block-level ancestor (or self): inline spans are rarely what the user means. */
export function pickContainer(el: Element): Element {
  if (el === document.body || el === document.documentElement) return el;
  if (BLOCK.has(el.tagName)) return el;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (BLOCK.has(p.tagName)) return p;
  }
  return el;
}

function classesOf(el: Element): string {
  return typeof el.className === "string" ? el.className.trim() : "";
}

export function selectorFor(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  for (let cur: Element | null = el; cur && cur !== document.body && parts.length < 4; cur = cur.parentElement) {
    let part = cur.tagName.toLowerCase();
    const cls = classesOf(cur)
      .split(/\s+/)
      .filter((c) => c && c.length < 30 && !/^(ng-|css-|emotion|styled)/.test(c))
      .slice(0, 2)
      .map((c) => CSS.escape(c))
      .join(".");
    if (cls) part += `.${cls}`;
    const siblings = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    parts.unshift(part);
  }
  return parts.join(" > ");
}

function fullPath(el: Element): string {
  const parts: string[] = [];
  for (let cur: Element | null = el; cur && parts.length < 8; cur = cur.parentElement) parts.unshift(cur.tagName.toLowerCase());
  return parts.join(" > ");
}

function componentName(el: Element): string {
  for (let cur: Element | null = el; cur && cur !== document.body; cur = cur.parentElement) {
    const direct = cur.getAttribute("data-component") || cur.getAttribute("data-testid") || cur.getAttribute("data-cy");
    if (direct) return direct;
    for (const attr of Array.from(cur.attributes)) {
      if (/^data-(component|react|vue|ng)/.test(attr.name)) return `${attr.name}=${attr.value}`;
    }
  }
  return "";
}

function styleSummary(el: Element): string {
  const cs = getComputedStyle(el);
  return [`color:${cs.color}`, `bg:${cs.backgroundColor}`, `font:${cs.fontSize}`, `pad:${cs.padding}`, `border:${cs.border}`].join(" ");
}

export function describeElement(el: Element): ElementMetadata {
  const r = el.getBoundingClientRect();
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  return {
    tagName: el.tagName,
    selector: selectorFor(el),
    fullPath: fullPath(el),
    classes: classesOf(el).slice(0, 200),
    text: (text ?? "").trim().slice(0, 200),
    component: componentName(el),
    bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    styles: styleSummary(el),
  };
}

export function findBySelector(selector: string | undefined): Element | null {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}
