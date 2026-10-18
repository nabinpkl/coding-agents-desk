/* Where everything the annotator draws is mounted: one layer that stays above the page, the page's
 * own modal dialogs and popovers included.
 *
 * A z-index cannot do that. `<dialog>.showModal()` and `showPopover()` put an element in the
 * browser's top layer, which paints above every z-index, and a modal dialog also makes the rest of
 * the page inert: nothing outside it takes a click or focus. So the layer is a manual popover, kept
 * in the top layer itself, and while a modal dialog is open it lives INSIDE that dialog, the only
 * place a modal leaves interactive. A popover shown above a modal from outside it would paint on
 * top and still not take a click. Being in the top layer also places the layer against the viewport
 * whatever the dialog's own transform, so fixed coordinates stay right inside it.
 *
 * Moving or re-showing it drops focus (an element taken out of the document loses it, and hiding a
 * popover hands focus back), so whatever had focus inside the layer gets it again afterwards: a
 * page tooltip opening must not take the caret out of a comment being typed. */

const LAYER_ID = "agentdesk-annotator-layer";

let layer: HTMLDivElement | null = null;
/** When each modal dialog was seen opening, so a stack of them resolves to the one on top. */
const openedAt = new WeakMap<Element, number>();
let clock = 0;

/** Appends `els` to the annotator's layer, creating the layer the first time. */
export function mount(...els: HTMLElement[]): void {
  ensureLayer().append(...els);
}

function ensureLayer(): HTMLDivElement {
  if (layer) return layer;
  const el = document.createElement("div");
  el.id = LAYER_ID;
  el.setAttribute("data-ax-ui", "1");
  el.popover = "manual";
  // The popover's own UA styles (a centred box with a border, padding and a Canvas background) are
  // undone: the layer is an invisible sheet the size of the viewport that lets every pointer
  // through, and its children say for themselves whether they take one.
  el.style.cssText =
    "position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;color:inherit;";
  layer = el;
  place();
  watch();
  return el;
}

/** The modal dialog the page has on top, or null. */
function topModal(): Element | null {
  let top: Element | null = null;
  let topAt = -1;
  // Document order breaks ties, which is the order a nested dialog usually opens in.
  for (const dialog of Array.from(document.querySelectorAll("dialog:modal"))) {
    const at = openedAt.get(dialog) ?? 0;
    if (at >= topAt) {
      top = dialog;
      topAt = at;
    }
  }
  return top;
}

/** The element that has focus, looking inside shadow roots, which the panel lives in. */
function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Puts the layer where it can be seen and used, and on top of the top layer. */
function place(raise = false): void {
  if (!layer) return;
  const parent = topModal() ?? document.documentElement;
  const moving = layer.parentNode !== parent;
  const open = layer.matches(":popover-open");
  if (open && !moving && !raise) return;
  const focused = document.activeElement && layer.contains(document.activeElement) ? deepActiveElement() : null;
  // Showing an open popover again does nothing, so going back on top means hiding it first.
  if (open) layer.hidePopover();
  if (moving) parent.append(layer);
  layer.showPopover();
  if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
}

function watch(): void {
  // A popover, and a dialog in Chrome 132 and later, says when it opens or closes. `toggle` does not
  // bubble, so it is heard on the way down.
  document.addEventListener(
    "toggle",
    (e) => {
      // A `<details>` fires `toggle` too, and is not in the top layer.
      if (e.target === layer || !(e.target instanceof HTMLDialogElement || (e.target instanceof HTMLElement && e.target.popover))) return;
      const opened = (e as ToggleEvent).newState === "open";
      if (opened) openedAt.set(e.target, ++clock);
      place(opened);
    },
    true,
  );
  // An older Chrome's dialog says nothing, so its `open` attribute is watched. And a dialog the page
  // removes while open takes the layer out of the document with it, closing it without an event.
  new MutationObserver((records) => {
    let raise = false;
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof HTMLDialogElement && r.target.open) {
        openedAt.set(r.target, ++clock);
        raise = true;
      }
    }
    // Most batches are the page's own rendering; `place` answers those with one dialog lookup.
    place(raise);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
}
