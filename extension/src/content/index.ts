/* Content script controller: picker overlay, state, and sync with the server
 * through the background. The server is the only home for annotations; the
 * panel shows what it returns. Text the user typed stays in its field until
 * the server has accepted it. */
import type { Annotation, ElementMetadata, NewAnnotation, Tag } from "../../../shared/annotation.ts";
import { buildBrief } from "../../../shared/brief.ts";
import { send, type AuthStatus, type HttpMethod, type Result, type TabMessage } from "../messages.ts";
import { captureElement, captureRegion, type Shot } from "./capture.ts";
import { createPanel, HOST_ID, type CaptureMode, type ConnStatus, type Panel, type PanelState } from "./panel.ts";
import { describeElement, findBySelector, pickContainer, regionAnchor } from "./picker.ts";
import { createRegionSelector, type RegionSelector } from "./region.ts";

type Region = NonNullable<ElementMetadata["region"]>;

/** Page (document) coordinates, so the region survives scrolling. */
function toRegion(r: DOMRect): Region {
  return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) };
}

function toViewport(g: Region): DOMRect {
  return new DOMRect(g.x - window.scrollX, g.y - window.scrollY, g.width, g.height);
}

/** Scrolls so the region is centred in the viewport where it fits, top-left aligned where it does not. */
function scrollToRegion(g: Region): void {
  window.scrollTo({
    left: g.x - Math.max(0, (window.innerWidth - g.width) / 2),
    top: g.y - Math.max(0, (window.innerHeight - g.height) / 2),
    behavior: "instant",
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

declare global {
  interface Window {
    __agentdeskAnnotatorLoaded?: boolean;
  }
}

if (!window.__agentdeskAnnotatorLoaded) {
  window.__agentdeskAnnotatorLoaded = true;
  main();
}

function main(): void {
  let active = false;
  let panel: Panel | null = null;
  let hoverEl: Element | null = null;
  let pendingEl: Element | null = null;
  let pendingShot: Shot | null = null;
  let pendingRegion: Region | null = null;
  let regionSel: RegionSelector | null = null;
  let capturing = false;
  let dim: HTMLDivElement | null = null;
  let box: HTMLDivElement | null = null;

  const state: {
    status: ConnStatus;
    statusDetail: string;
    serverLabel: string;
    items: Annotation[];
    mode: CaptureMode;
    listOpen: boolean;
    signingIn: boolean;
    busy: Set<number>;
    errors: Map<number, string>;
    thumbs: Map<number, string>;
    replyOpen: number | null;
    replyDrafts: Map<number, string>;
  } = {
    status: "unknown",
    statusDetail: "",
    serverLabel: "",
    items: [],
    mode: "element",
    listOpen: true,
    signingIn: false,
    busy: new Set(),
    errors: new Map(),
    thumbs: new Map(),
    replyOpen: null,
    replyDrafts: new Map(),
  };

  function render(): void {
    if (!panel) return;
    panel.render(state as PanelState);
    syncRegionArm();
    drawMarkers();
    void send({ type: "badge", count: state.items.filter((a) => a.status === "open").length });
  }

  /** Folds a call's failure into the connection state; returns the data on success. */
  async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<Result<T>> {
    const res = await send<T>({ type: "api", method, path, body });
    if (res.ok) {
      state.status = "connected";
    } else if (res.kind === "signed-out" || res.kind === "offline") {
      state.status = res.kind;
      state.statusDetail = res.error;
    }
    return res;
  }

  function replace(a: Annotation): void {
    const i = state.items.findIndex((x) => x.id === a.id);
    if (i >= 0) state.items[i] = a;
    else state.items.push(a);
  }

  async function loadThumb(a: Annotation): Promise<void> {
    if (!a.screenshot) return;
    const res = await send<string>({ type: "screenshot-data-url", id: a.id });
    if (res.ok) {
      state.thumbs.set(a.id, res.data);
      render();
    }
  }

  async function pull(): Promise<void> {
    const auth = await send<AuthStatus>({ type: "auth-status" });
    if (auth.ok) state.serverLabel = new URL(auth.data.serverUrl).host;
    const res = await call<Annotation[]>("GET", `/api/v1/annotations?url=${encodeURIComponent(location.href)}`);
    if (res.ok) {
      state.items = res.data.sort((a, b) => a.id - b.id);
      state.thumbs.clear();
      for (const a of state.items) void loadThumb(a);
    }
    render();
  }

  /** Runs one item action with a busy flag and an inline error on failure. */
  async function itemAction(a: Annotation, run: () => Promise<Result<Annotation | null>>): Promise<boolean> {
    state.busy.add(a.id);
    state.errors.delete(a.id);
    render();
    const res = await run();
    state.busy.delete(a.id);
    if (res.ok) {
      if (res.data) replace(res.data);
    } else if (res.kind === "http") {
      state.errors.set(a.id, res.error);
    }
    render();
    return res.ok;
  }

  // ----- form -----

  function openForm(el: Element, shot: Shot | null, region: Region | null = null): void {
    pendingEl = el;
    pendingShot = shot;
    pendingRegion = region;
    const selector = describeElement(el).selector ?? "?";
    const detail = region ? `${region.width} \u00d7 ${region.height} in ${selector}` : selector;
    panel?.openForm(region ? "region" : "container", shot ? `${detail}  +  screenshot` : detail);
    syncRegionArm();
  }

  function cancelForm(): void {
    pendingEl = null;
    pendingShot = null;
    pendingRegion = null;
    panel?.closeForm();
    syncRegionArm();
  }

  async function save(text: string, tag: Tag): Promise<void> {
    if (!panel || !pendingEl) return;
    if (!text) {
      panel.setFormError("Write what is wrong first.");
      return;
    }
    const metadata: ElementMetadata = pendingRegion ? { ...describeElement(pendingEl), region: pendingRegion } : describeElement(pendingEl);
    const input: NewAnnotation = { url: location.href, title: document.title, text, tag, metadata };
    panel.setFormBusy(true);
    panel.setFormError("");
    const created = await call<Annotation>("POST", "/api/v1/annotations", input);
    if (!created.ok) {
      panel.setFormBusy(false);
      panel.setFormError(created.kind === "signed-out" ? "Signed out: sign in from the list, then Save again." : `Not saved: ${created.error}`);
      render();
      return;
    }
    replace(created.data);
    const shot = pendingShot;
    panel.setFormBusy(false);
    cancelForm();
    render();
    if (shot) await uploadShot(created.data, shot);
  }

  async function uploadShot(a: Annotation, shot: Shot): Promise<void> {
    const ok = await itemAction(a, () => call<Annotation>("PUT", `/api/v1/annotations/${a.id}/screenshot`, shot));
    if (ok) state.thumbs.set(a.id, `data:${shot.mime};base64,${shot.dataBase64}`);
    render();
  }

  // ----- panel handlers -----

  function brief(): string {
    return buildBrief(
      state.items.filter((a) => a.status === "open"),
      { url: location.href, title: document.title },
    );
  }

  async function copyText(text: string): Promise<void> {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Plain-http pages have no async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("data-ax-ui", "1");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.documentElement.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("clipboard unavailable on this page");
  }

  function ensurePanel(): Panel {
    panel ??= createPanel({
      setMode(mode) {
        state.mode = mode;
        hoverEl = null;
        render();
      },
      copy() {
        copyText(brief()).catch((e: unknown) => {
          window.alert(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      },
      download() {
        const url = URL.createObjectURL(new Blob([brief()], { type: "text/markdown" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "annotate-brief.md";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      toggleList() {
        state.listOpen = !state.listOpen;
        render();
      },
      async clear() {
        if (!window.confirm("Delete every annotation for this page from the server?")) return;
        const res = await call<{ removed: number }>("DELETE", `/api/v1/annotations?url=${encodeURIComponent(location.href)}`);
        if (res.ok) {
          state.items = [];
          state.thumbs.clear();
        }
        render();
      },
      close() {
        setActive(false);
      },
      async signIn() {
        state.signingIn = true;
        render();
        const res = await send<AuthStatus>({ type: "sign-in" });
        state.signingIn = false;
        if (!res.ok) {
          state.statusDetail = res.error;
          render();
          return;
        }
        await pull();
      },
      retry() {
        void pull();
      },
      locate(a) {
        if (a.metadata.region) {
          flashRegion(a.metadata.region);
          return;
        }
        const el = findBySelector(a.metadata.selector);
        if (!(el instanceof HTMLElement)) return;
        el.scrollIntoView({ block: "center" });
        const old = el.style.outline;
        el.style.outline = "2px solid #d32f2f";
        setTimeout(() => {
          el.style.outline = old;
        }, 900);
      },
      resolve(a) {
        void itemAction(a, () => call("POST", `/api/v1/annotations/${a.id}/resolve`));
      },
      reopen(a) {
        void itemAction(a, () => call("POST", `/api/v1/annotations/${a.id}/reopen`));
      },
      async remove(a) {
        if (!window.confirm("Delete this annotation from the server?")) return;
        const ok = await itemAction(a, () => call<null>("DELETE", `/api/v1/annotations/${a.id}`));
        if (ok) {
          state.items = state.items.filter((x) => x.id !== a.id);
          state.thumbs.delete(a.id);
          render();
        }
      },
      openReply(a) {
        state.replyOpen = state.replyOpen === a.id ? null : a.id;
        render();
      },
      draftReply(a, text) {
        state.replyDrafts.set(a.id, text);
      },
      async sendReply(a) {
        const text = (state.replyDrafts.get(a.id) ?? "").trim();
        if (!text) return;
        const ok = await itemAction(a, () => call("POST", `/api/v1/annotations/${a.id}/replies`, { text }));
        if (ok) {
          state.replyDrafts.delete(a.id);
          state.replyOpen = null;
          render();
        }
      },
      async shoot(a) {
        const region = a.metadata.region;
        const el = findBySelector(a.metadata.selector);
        if (!el && !region) {
          state.errors.set(a.id, "Element not found on this page anymore.");
          render();
          return;
        }
        try {
          if (region) scrollToRegion(region);
          const shot = region
            ? await withoutOverlays(() => captureRegion(toViewport(region), el ?? document.body))
            : await withoutOverlays(() => captureElement(el!));
          await uploadShot(a, shot);
        } catch (e) {
          state.errors.set(a.id, e instanceof Error ? e.message : String(e));
          render();
        }
      },
      save(text, tag) {
        void save(text, tag);
      },
      cancelForm,
    });
    return panel;
  }

  // ----- picker overlay -----

  function inUI(el: Element): boolean {
    return el.id === HOST_ID || Boolean(el.closest("[data-ax-ui]"));
  }

  function ensureOverlay(): void {
    if (dim) return;
    dim = document.createElement("div");
    box = document.createElement("div");
    for (const el of [dim, box]) el.setAttribute("data-ax-ui", "1");
    dim.style.cssText = "position:fixed;inset:0;z-index:2147483644;background:rgba(0,0,0,.3);pointer-events:none;display:none;";
    box.style.cssText = "position:fixed;z-index:2147483645;background:rgba(66,133,244,.22);border:1px solid rgba(66,133,244,.9);pointer-events:none;display:none;";
    document.documentElement.append(dim, box);
  }

  /** Hides everything the annotator draws for two frames' worth of paint, so a capture shows only the page. */
  async function withoutOverlays<T>(run: () => Promise<T>): Promise<T> {
    capturing = true;
    const host = panel?.host;
    const hidden = [host, ...Array.from(document.querySelectorAll<HTMLElement>("[data-ax-marker]"))].filter((el): el is HTMLElement => Boolean(el));
    for (const el of hidden) el.style.visibility = "hidden";
    if (dim && box) dim.style.display = box.style.display = "none";
    syncRegionArm();
    try {
      await nextFrame();
      await nextFrame();
      return await run();
    } finally {
      for (const el of hidden) el.style.visibility = "";
      capturing = false;
      syncRegionArm();
    }
  }

  function syncRegionArm(): void {
    const on = active && state.mode === "region" && !panel?.formOpen() && !capturing;
    if (on) regionSel ??= createRegionSelector(onRegion);
    regionSel?.arm(on);
  }

  function onRegion(rect: DOMRect): void {
    const region = toRegion(rect);
    const anchor = regionAnchor(rect);
    withoutOverlays(() => captureRegion(rect, anchor)).then(
      (shot) => openForm(anchor, shot, region),
      (err: unknown) => {
        openForm(anchor, null, region);
        panel?.setFormError(`Screenshot failed, saving without it: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  function flashRegion(g: Region): void {
    scrollToRegion(g);
    const r = toViewport(g);
    const flash = document.createElement("div");
    flash.setAttribute("data-ax-ui", "1");
    flash.style.cssText = `position:fixed;z-index:2147483645;pointer-events:none;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #d32f2f;`;
    document.documentElement.append(flash);
    setTimeout(() => flash.remove(), 900);
  }

  function paint(): void {
    if (dim && box) {
      const show = active && state.mode !== "region" && !capturing && !panel?.formOpen() && hoverEl && document.contains(hoverEl);
      dim.style.display = show ? "block" : "none";
      box.style.display = show ? "block" : "none";
      if (show && hoverEl) {
        const r = hoverEl.getBoundingClientRect();
        Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(r.width, 0)}px`, height: `${Math.max(r.height, 0)}px` });
      }
    }
    if (active) requestAnimationFrame(paint);
  }

  function drawMarkers(): void {
    for (const m of Array.from(document.querySelectorAll("[data-ax-marker]"))) m.remove();
    if (!active) return;
    const colors: Record<Tag, string> = { comment: "#2f6fd6", bug: "#d32f2f", change: "#7b3fc0", suggestion: "#2e7d32", question: "#b7791f", info: "#6b6b6b" };
    state.items.forEach((a, i) => {
      if (a.status !== "open") return;
      let r: DOMRect;
      if (a.metadata.region) {
        r = toViewport(a.metadata.region);
      } else {
        const el = findBySelector(a.metadata.selector);
        if (!el) return;
        r = el.getBoundingClientRect();
      }
      const m = document.createElement("div");
      m.setAttribute("data-ax-marker", "1");
      m.setAttribute("data-ax-ui", "1");
      m.textContent = String(i + 1);
      m.style.cssText = `position:fixed;z-index:2147483646;left:${r.left}px;top:${r.top - 22}px;background:${colors[a.tag]};color:#fff;font:12px/20px sans-serif;min-width:20px;text-align:center;border-radius:10px;pointer-events:none;`;
      document.documentElement.append(m);
    });
  }

  function onMove(e: MouseEvent): void {
    if (!active || state.mode === "region" || !(e.target instanceof Element) || inUI(e.target)) return;
    hoverEl = pickContainer(e.target);
  }

  function onClick(e: MouseEvent): void {
    if (!active || state.mode === "region" || panel?.formOpen() || !(e.target instanceof Element) || inUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = pickContainer(e.target);
    if (state.mode === "element") {
      openForm(target, null);
      return;
    }
    withoutOverlays(() => captureElement(target)).then(
      (shot) => openForm(target, shot),
      (err: unknown) => {
        openForm(target, null);
        panel?.setFormError(`Screenshot failed, saving without it: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  function onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const editable = t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    if (e.altKey && e.shiftKey && e.code === "KeyA" && !editable) {
      e.preventDefault();
      setActive(!active);
    } else if (e.key === "Escape" && active) {
      if (regionSel?.dragging()) regionSel.cancelDrag();
      else if (panel?.formOpen()) cancelForm();
      else setActive(false);
    }
  }

  function setActive(on: boolean): void {
    active = on;
    const p = ensurePanel();
    p.show(on);
    if (on) {
      ensureOverlay();
      requestAnimationFrame(paint);
      void pull();
    } else {
      cancelForm();
      hoverEl = null;
      paint();
      drawMarkers();
    }
    render();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", () => active && drawMarkers(), { passive: true });

  chrome.runtime.onMessage.addListener((msg: TabMessage) => {
    if (msg.type === "toggle") setActive(!active);
    if (msg.type === "auth-changed" && active) void pull();
  });
}
