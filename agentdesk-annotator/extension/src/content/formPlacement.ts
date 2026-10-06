/* Where the comment form sits on the page: beside what it is about rather than over it, and then
 * wherever the reader drags it. A form that covers its own element hides the very thing being
 * described, and with a font size being previewed, the change being judged. */

/** Space between the form and the element, and between the form and the viewport's edge. */
const GAP = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function overlaps(a: { left: number; top: number; width: number; height: number }, b: DOMRect): boolean {
  return a.left < b.right && a.left + a.width > b.left && a.top < b.bottom && a.top + a.height > b.top;
}

/**
 * Puts a visible form beside `target` (viewport coordinates): to its right, else its left, else
 * below, else above, keeping the form inside the viewport. Where none of those fits, the form goes
 * to the half of the screen away from the element's middle, and the reader can drag it from there.
 */
export function placeBeside(form: HTMLElement, target: DOMRect): void {
  const { width, height } = form.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitTop = clamp(target.top, GAP, vh - height - GAP);
  const fitLeft = clamp(target.left, GAP, vw - width - GAP);
  const candidates = [
    { left: target.right + GAP, top: fitTop },
    { left: target.left - GAP - width, top: fitTop },
    { left: fitLeft, top: target.bottom + GAP },
    { left: fitLeft, top: target.top - GAP - height },
  ];
  const inside = (c: { left: number; top: number }) => c.left >= GAP && c.top >= GAP && c.left + width <= vw - GAP && c.top + height <= vh - GAP;
  const spot = candidates.find((c) => inside(c) && !overlaps({ ...c, width, height }, target)) ?? {
    left: clamp((vw - width) / 2, GAP, vw - width - GAP),
    top: target.top + target.height / 2 > vh / 2 ? GAP : clamp(vh - height - GAP, GAP, vh),
  };
  moveTo(form, spot.left, spot.top);
}

function moveTo(form: HTMLElement, left: number, top: number): void {
  form.style.transform = "none";
  form.style.left = `${Math.round(left)}px`;
  form.style.top = `${Math.round(top)}px`;
}

/** Lets the reader move `form` by dragging `handle`, held inside the viewport. Buttons in the handle stay buttons. */
export function makeDraggable(form: HTMLElement, handle: HTMLElement): void {
  let start: { x: number; y: number; left: number; top: number } | null = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button"))) return;
    e.preventDefault();
    const r = form.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    const r = form.getBoundingClientRect();
    moveTo(
      form,
      clamp(start.left + e.clientX - start.x, 0, window.innerWidth - r.width),
      clamp(start.top + e.clientY - start.y, 0, window.innerHeight - r.height),
    );
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    start = null;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
