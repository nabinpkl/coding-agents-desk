/* Element screenshot: capture the visible tab (background), crop to the
 * element at device pixel ratio, downscale past 1200px, and record a bounded
 * dump of the DOM nodes it covers. */
import type { Coverage, CoverageItem } from "../../../shared/annotation.ts";
import { send } from "../messages.ts";
import { selectorFor } from "./picker.ts";

export interface Shot {
  mime: "image/jpeg";
  dataBase64: string;
  coverage: Coverage;
}

const MAX_WIDTH = 1200;
const MAX_NODES = 80;
const MAX_DEPTH = 6;

function crop(dataUrl: string, rect: DOMRect, dpr: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sx = Math.max(0, rect.left) * dpr;
      const sy = Math.max(0, rect.top) * dpr;
      const sw = Math.min(rect.width * dpr, img.naturalWidth - sx);
      const sh = Math.min(rect.height * dpr, img.naturalHeight - sy);
      if (sw < 2 || sh < 2) {
        reject(new Error("element is not visible in the viewport"));
        return;
      }
      const k = Math.min(1, MAX_WIDTH / sw);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw * k);
      canvas.height = Math.round(sh * k);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => reject(new Error("captured image failed to load"));
    img.src = dataUrl;
  });
}

function coverage(container: Element): Coverage {
  const all = container.querySelectorAll("*");
  const items: CoverageItem[] = [];
  for (let i = 0; i < all.length && items.length < MAX_NODES; i++) {
    const el = all[i]!;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    let depth = 0;
    let p: Element | null = el;
    while (p && p !== container && depth <= MAX_DEPTH) {
      p = p.parentElement;
      depth++;
    }
    if (p !== container) continue;
    const text = ((el instanceof HTMLElement ? el.innerText : el.textContent) ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!text && !el.id && !(typeof el.className === "string" && el.className.trim())) continue;
    items.push({ selector: selectorFor(el), tag: el.tagName, text });
  }
  return { scanned: all.length, items };
}

export async function captureElement(el: Element): Promise<Shot> {
  const rect = el.getBoundingClientRect();
  const res = await send<string>({ type: "capture-visible-tab" });
  if (!res.ok) throw new Error(`capture failed: ${res.error}`);
  const jpeg = await crop(res.data, rect, window.devicePixelRatio || 1);
  return { mime: "image/jpeg", dataBase64: jpeg.slice(jpeg.indexOf(",") + 1), coverage: coverage(el) };
}
