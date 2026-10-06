/* The banner that says the page is being previewed, and the frame around the window that makes a
 * modified page impossible to mistake for the real one. The banner carries everything the preview
 * needs once it holds changes: compare, review, save, discard and leave. */
import { h, iconButton, textButton } from "./dom.ts";

export interface PreviewRow {
  selector: string;
  /** The change in words, such as `Font size 16px → 21px`. */
  text: string;
  /** How many elements the selector matches here now: 0 means the element is not on this page. */
  matches: number;
}

export interface PreviewView {
  changes: PreviewRow[];
  saved: number;
  comparing: boolean;
  problem: string;
}

export interface PreviewBannerHandlers {
  compare(holding: boolean): void;
  saveDraft(): void;
  discardDraft(): void;
  leavePreview(): void;
  undoChange(selector: string): void;
  locateChange(selector: string): void;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function createPreviewBanner(on: PreviewBannerHandlers): { banner: HTMLElement; frame: HTMLElement; render(view: PreviewView | null): void } {
  let reviewOpen = false;
  let last: PreviewView | null = null;

  const text = h("span", { class: "pbanner-text", role: "status" });
  const compareBtn = h("button", { class: "text-btn", type: "button", title: "Hold to see the page without your changes (or hold ` )" }, "Hold to compare");
  const release = () => on.compare(false);
  compareBtn.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    on.compare(true);
  });
  compareBtn.addEventListener("pointerup", release);
  compareBtn.addEventListener("pointerleave", release);
  compareBtn.addEventListener("pointercancel", release);
  compareBtn.addEventListener("blur", release);
  compareBtn.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      on.compare(true);
    }
  });
  compareBtn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") release();
  });
  compareBtn.addEventListener("click", (e) => e.stopPropagation());

  const reviewBtn = textButton("Review", () => {
    reviewOpen = !reviewOpen;
    render(last);
  }, { "aria-expanded": "false" });
  const saveBtn = h("button", { class: "primary", type: "button" }, "Save");
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    on.saveDraft();
  });
  const discardBtn = textButton("Discard", () => on.discardDraft(), { class: "text-btn danger-text" });
  const exitBtn = iconButton("x", "Leave preview (your changes are kept)", () => on.leavePreview());
  const problem = h("div", { class: "pbanner-problem", role: "alert" });
  const list = h("div", { class: "pbanner-list", role: "list", "aria-label": "Previewed changes" });

  const banner = h(
    "div",
    { class: "pbanner", role: "region", "aria-label": "Preview", hidden: true },
    h("div", { class: "pbanner-row" }, h("span", { class: "pbanner-dot", "aria-hidden": "true" }), text, compareBtn, reviewBtn, saveBtn, discardBtn, exitBtn),
    problem,
    list,
  );
  const frame = h("div", { class: "pframe", "aria-hidden": "true", hidden: true });

  function row(r: PreviewRow): HTMLElement {
    const where = r.matches === 0 ? "not on this page" : r.matches > 1 ? `${r.matches} elements` : "";
    const show = h(
      "button",
      { class: "pchange-show", type: "button", title: r.matches === 0 ? "Not on this page" : "Show it on the page", disabled: r.matches === 0 },
      h("span", { class: "pchange-what" }, r.text),
      h("span", { class: "pchange-sel" }, r.selector),
      ...(where ? [h("span", { class: "pchange-where" }, where)] : []),
    );
    show.addEventListener("click", (e) => {
      e.stopPropagation();
      on.locateChange(r.selector);
    });
    return h("div", { class: "pchange", role: "listitem" }, show, iconButton("undo", `Undo ${r.text}`, () => on.undoChange(r.selector)));
  }

  function render(view: PreviewView | null): void {
    last = view;
    banner.hidden = frame.hidden = view === null;
    if (!view) return;
    const n = view.changes.length;
    text.textContent = view.comparing
      ? "Showing the page without your changes"
      : `Preview · ${plural(n, "change")}${view.saved ? ` · ${view.saved} saved` : ""}`;
    frame.toggleAttribute("data-comparing", view.comparing);
    banner.toggleAttribute("data-comparing", view.comparing);
    reviewBtn.textContent = reviewOpen && n > 0 ? "Hide review" : "Review";
    reviewBtn.setAttribute("aria-expanded", String(reviewOpen && n > 0));
    reviewBtn.disabled = n === 0;
    saveBtn.textContent = n > 0 ? `Save ${n}` : "Save";
    saveBtn.disabled = discardBtn.disabled = n === 0;
    problem.textContent = view.problem;
    list.hidden = !reviewOpen || n === 0;
    list.replaceChildren(...view.changes.map(row));
  }

  return { banner, frame, render };
}
