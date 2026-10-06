/* The few DOM builders the panel's pieces share. Page and user text reaches the DOM only as a child
 * string, which `append` sets as text, never as markup. */
import { icon, type IconName } from "./icons.ts";

export type Attrs = Record<string, string | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) el.append(c);
  return el;
}

export function iconButton(name: IconName, label: string, onClick: () => void, opts: { danger?: boolean; disabled?: boolean; busy?: boolean } = {}): HTMLButtonElement {
  const b = h("button", {
    class: `icon-btn${opts.danger ? " danger" : ""}`,
    type: "button",
    "aria-label": label,
    title: label,
    disabled: opts.disabled || opts.busy,
    "aria-busy": opts.busy ? "true" : undefined,
  }, icon(name));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export function textButton(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h("button", { class: "text-btn", type: "button", ...attrs }, label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
