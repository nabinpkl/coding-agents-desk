// Evidence for one open question: why a canvas strip is found scrolled to its far end after the
// panel or the sidecar restarts, when it should be where the reader left it.
//
// Every attempt to reproduce it in a debug browser held the offset -- a reload, the snapshot a
// freshly started sidecar sends, every stream cut at once -- so the answer has to come from the
// reader's own tab. This records, from that tab, everything that moves a strip and everything that
// could be the reason: page loads, the dev server's hot updates and full reloads, the sidecar's
// streams going down and coming back, and each scroll with what caused it. The sidecar appends it
// to `<user>-panel-scroll.log`, beside its own log, so the two can be read on one clock.
//
// A scroll's cause is judged in order. `clamp` first: the strip got narrower than the last scroll
// saw and the offset sits at the new end, which is the browser pinning it -- whatever input happened
// to be near. Then the latest of a write this module saw (`scrollLeft`, `scrollTo`, `scrollBy`,
// `scrollIntoView`, `focus`, with the caller's frames) and the reader's own input, within a short
// window. Neither leaves `browser`. A clamp or a write that lands at the end is what this is for.
//
// It patches `scrollIntoView` and `focus` on the prototypes once per page, so an edit to this file
// that hot-reloads stacks a second pair; reload the page after changing it.
//
// Events are sent in batches. What has not gone when the page is hidden is kept in sessionStorage
// and sent by the next load, because the moments around a reload are exactly the ones wanted.

import { type RefObject, useEffect, useRef } from "react";
import { devServerHooks } from "@/features/profile/panelBuild";

const ROUTE = "/api/panel/scroll-diagnostics";
const PENDING_KEY = "agent-panel.scroll-diagnostics.pending";
const FLUSH_MS = 2000;
const MAX_BUFFER = 2000;
/** How long after a write or an input a scroll is still attributed to it. */
const CAUSE_WINDOW_MS = 800;
/** A scroll that keeps going is logged at most this often; where it stops is always logged. */
const SCROLL_LOG_MS = 250;
const SETTLE_MS = 300;

export type StripName = "bot-canvas" | "terminal-canvas";

interface DiagnosticEvent {
  t: number;
  kind: string;
  [field: string]: unknown;
}

const page = Math.random().toString(36).slice(2, 8);
let buffer: DiagnosticEvent[] = [];
let dropped = 0;
let installed = false;
let sending = false;
/** What the previous load of this tab left unsent, sent under its own page until it lands. */
let carried: { page: string; events: DiagnosticEvent[] } | null = null;

/** The dev server's hot channel, which is also what says this page records at all: never a test. */
const hot = devServerHooks(import.meta.hot);

function enabled(): boolean {
  return hot !== undefined && typeof window !== "undefined";
}

export function noteScroll(kind: string, fields: Record<string, unknown> = {}): void {
  if (!enabled()) return;
  install();
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    dropped += 1;
  }
  buffer.push({ t: Date.now(), kind, ...fields });
}

/**
 * Sends one batch under the page that recorded it. False means try again: the sidecar was not
 * there or failed to write. A batch it refuses is off the contract and would be refused forever,
 * so that is said once and the batch let go.
 */
async function send(from: string, events: DiagnosticEvent[]): Promise<boolean> {
  try {
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: from, events }),
    });
    if (response.status >= 400 && response.status < 500) {
      console.warn(`scroll diagnostics: the sidecar refused a batch: ${await response.text()}`);
      return true;
    }
    return response.ok;
  } catch {
    return false;
  }
}

async function flush(): Promise<void> {
  if (sending) return;
  if (carried !== null) {
    sending = true;
    if (await send(carried.page, carried.events)) carried = null;
    sending = false;
  }
  if (buffer.length === 0) return;
  sending = true;
  const batch = buffer;
  buffer = [];
  if (dropped > 0) {
    batch.unshift({ t: Date.now(), kind: "buffer.dropped", count: dropped });
    dropped = 0;
  }
  // A sidecar that is restarting is one of the moments being recorded: keep the batch and send it
  // with the next one.
  if (!(await send(page, batch))) buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
  sending = false;
}

/** Starts recording this page. Called once from `main.tsx`; every recorder also calls it. */
export function installScrollDiagnostics(): void {
  if (enabled()) install();
}

function install(): void {
  if (installed) return;
  installed = true;
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    // Sent under the page that recorded them, so a reload reads as two pages rather than one.
    const left = (raw ? JSON.parse(raw) : null) as { page?: unknown; events?: unknown } | null;
    if (left && typeof left.page === "string" && Array.isArray(left.events)) {
      carried = { page: left.page, events: (left.events as DiagnosticEvent[]).slice(-MAX_BUFFER) };
    }
  } catch {
    // Nothing carried over; this load's own events still record.
  }
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  buffer.push({
    // When the page began loading, not when this ran, so it lines up with what restarted it.
    t: Math.round(performance.timeOrigin),
    kind: "page.load",
    navigation: navigation?.type ?? "unknown",
    url: location.pathname + location.search,
    visible: document.visibilityState,
  });
  setInterval(() => void flush(), FLUSH_MS);
  window.addEventListener("pagehide", () => {
    buffer.push({ t: Date.now(), kind: "page.hide" });
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ page, events: buffer.slice(-MAX_BUFFER) }));
      buffer = [];
    } catch {
      // Storage refused: what was buffered is lost with the page.
    }
  });
  document.addEventListener("visibilitychange", () => {
    buffer.push({ t: Date.now(), kind: document.hidden ? "page.hidden" : "page.visible" });
  });
  if (hot) {
    hot.on("vite:beforeUpdate", (payload) => {
      const updates = (payload as { updates?: { path: string }[] } | undefined)?.updates ?? [];
      noteScroll("hmr.update", { paths: updates.map((update) => update.path).slice(0, 10) });
    });
    hot.on("vite:beforeFullReload", (payload) => {
      noteScroll("hmr.full-reload", { path: (payload as { path?: string } | undefined)?.path ?? null });
    });
    hot.on("vite:ws:disconnect", () => noteScroll("hmr.disconnect"));
    hot.on("vite:ws:connect", () => noteScroll("hmr.connect"));
  }
  installWriteWatch();
}

// ---- The sidecar's streams, as one outage rather than one line per stream.
//
// Every stream on this page goes to one sidecar, so the first error after a healthy stretch is the
// outage starting and the first open after it is the outage over, whichever streams those are.

let down: { since: number; first: string; errors: number } | null = null;

/** Handlers for one EventSource: call `open` and `error` on its events. */
export function noteStream(path: string): { open: () => void; error: () => void } {
  return {
    open: () => {
      if (down === null) return;
      noteScroll("streams.up", { downMs: Date.now() - down.since, errors: down.errors, first: path.slice(0, 120) });
      down = null;
    },
    error: () => {
      if (down !== null) {
        down.errors += 1;
        return;
      }
      down = { since: Date.now(), first: path.slice(0, 120), errors: 1 };
      noteScroll("streams.down", { first: down.first });
    },
  };
}

// ---- Who moved a strip.

interface Watched {
  name: StripName;
  element: HTMLElement;
  writer: { at: number; how: string; from: string } | null;
  input: { at: number; how: string } | null;
}

const watched = new Set<Watched>();

/** The first frames that are not this module's, which is who asked for the move. */
function caller(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => !frame.includes("scrollDiagnostics"));
  return frames.slice(0, 3)
    .map((frame) => frame.replace(/^at /, "").replace(/https?:\/\/[^/]+\/(@fs)?/, "").replace(/\?[^:)]*/, ""))
    .join(" < ");
}

function markWriters(target: Element, how: string): void {
  for (const strip of watched) {
    if (strip.element === target || strip.element.contains(target)) {
      strip.writer = { at: performance.now(), how, from: caller() };
    }
  }
}

/** `scrollIntoView` and `focus` both scroll every ancestor, and neither says so on the ancestor. */
function installWriteWatch(): void {
  const intoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element["scrollIntoView"]>) {
    if (watched.size > 0) markWriters(this, "scrollIntoView");
    return intoView.apply(this, args);
  };
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (watched.size > 0 && !options?.preventScroll) markWriters(this, "focus");
    return focus.call(this, options);
  };
}

function position(element: HTMLElement): Record<string, number | boolean> {
  const max = element.scrollWidth - element.clientWidth;
  return {
    left: Math.round(element.scrollLeft),
    max,
    width: element.scrollWidth,
    client: element.clientWidth,
    atEnd: max > 0 && element.scrollLeft >= max - 1,
  };
}

/** The cause of a scroll happening now: the latest write or input inside the window, or the browser. */
function causeOf(strip: Watched): Record<string, string> {
  const now = performance.now();
  const writer = strip.writer && now - strip.writer.at < CAUSE_WINDOW_MS ? strip.writer : null;
  const input = strip.input && now - strip.input.at < CAUSE_WINDOW_MS ? strip.input : null;
  if (writer && (!input || writer.at >= input.at)) return { cause: writer.how, from: writer.from };
  if (input) return { cause: `input:${input.how}` };
  return { cause: "browser" };
}

/**
 * Records every move of one strip's scroller until the returned function is called. `stored` reads
 * what the strip has remembered, so each line can be compared with it.
 */
export function watchStrip(name: StripName, element: HTMLElement, stored: () => unknown): () => void {
  if (!enabled()) return () => {};
  install();
  const strip: Watched = { name, element, writer: null, input: null };
  watched.add(strip);
  noteScroll("strip.attach", { strip: name, stored: stored(), ...position(element) });

  // The element's own accessors, shadowing the prototype's, so a write by any code is seen.
  const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get() {
      return proto.get!.call(element);
    },
    set(value: number) {
      const before = proto.get!.call(element) as number;
      proto.set!.call(element, value);
      if (Math.abs((proto.get!.call(element) as number) - before) > 1) {
        strip.writer = { at: performance.now(), how: "scrollLeft", from: caller() };
      }
    },
  });
  const scrollTo = element.scrollTo.bind(element);
  const scrollBy = element.scrollBy.bind(element);
  element.scrollTo = ((...args: unknown[]) => {
    strip.writer = { at: performance.now(), how: "scrollTo", from: caller() };
    return (scrollTo as (...a: unknown[]) => void)(...args);
  }) as typeof element.scrollTo;
  element.scrollBy = ((...args: unknown[]) => {
    strip.writer = { at: performance.now(), how: "scrollBy", from: caller() };
    return (scrollBy as (...a: unknown[]) => void)(...args);
  }) as typeof element.scrollBy;

  const onInput = (event: Event): void => {
    strip.input = { at: performance.now(), how: event.type };
  };
  const inputs = ["wheel", "touchstart", "pointerdown"] as const;
  for (const type of inputs) element.addEventListener(type, onInput, { passive: true, capture: true });
  window.addEventListener("keydown", onInput, true);

  let lastLogged = 0;
  let lastCause = "";
  let settle: ReturnType<typeof setTimeout> | null = null;
  // The width as the last scroll saw it. A scroll that arrives with the strip narrower than that and
  // the offset at the new end is the browser clamping, whatever input happened to be near it.
  let seenWidth = element.scrollWidth;
  let seenLeft = element.scrollLeft;
  const onScroll = (): void => {
    const max = element.scrollWidth - element.clientWidth;
    const clamped = element.scrollWidth < seenWidth - 1 && element.scrollLeft >= max - 1;
    const cause = clamped ? { cause: "clamp", shrunkFrom: String(seenWidth) } : causeOf(strip);
    seenWidth = element.scrollWidth;
    seenLeft = element.scrollLeft;
    const now = performance.now();
    if (cause.cause !== lastCause || now - lastLogged >= SCROLL_LOG_MS) {
      noteScroll("strip.scroll", { strip: name, ...position(element), ...cause });
      lastLogged = now;
      lastCause = cause.cause;
    }
    if (settle !== null) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      noteScroll("strip.settle", { strip: name, ...position(element), stored: stored() });
      lastCause = "";
    }, SETTLE_MS);
  };
  element.addEventListener("scroll", onScroll, { passive: true });

  // The width the strip can scroll through, which moves without any scroll when cards fill in or
  // leave -- and a strip that shrinks past the offset is clamped by the browser.
  let width = element.scrollWidth;
  const resized = new ResizeObserver(() => {
    // A resize that left the offset alone clamped nothing, so it becomes the width to judge by. One
    // that moved it is a clamp whose scroll event is still on its way, and must find the old width.
    if (Math.abs(element.scrollLeft - seenLeft) <= 1) seenWidth = element.scrollWidth;
    if (Math.abs(element.scrollWidth - width) <= 1) return;
    width = element.scrollWidth;
    noteScroll("strip.resize", { strip: name, ...position(element) });
  });
  resized.observe(element);
  const content = element.querySelector("ul");
  if (content) resized.observe(content);

  return () => {
    noteScroll("strip.detach", { strip: name, stored: stored(), ...position(element) });
    watched.delete(strip);
    resized.disconnect();
    if (settle !== null) clearTimeout(settle);
    element.removeEventListener("scroll", onScroll);
    for (const type of inputs) element.removeEventListener(type, onInput, true);
    window.removeEventListener("keydown", onInput, true);
    delete (element as { scrollLeft?: number }).scrollLeft;
    delete (element as { scrollTo?: unknown }).scrollTo;
    delete (element as { scrollBy?: unknown }).scrollBy;
  };
}

/**
 * Watches whichever element `scroller` holds, following it when it is replaced: the terminal strip
 * swaps its scroller for a placeholder while it loads, and a new element starts at offset zero.
 */
export function useStripDiagnostics(
  name: StripName,
  scroller: RefObject<HTMLElement | null>,
  stored: () => unknown,
): void {
  const current = useRef<{ element: HTMLElement; stop: () => void } | null>(null);
  const read = useRef(stored);
  read.current = stored;
  useEffect(() => {
    const element = scroller.current;
    if (current.current?.element === element) return;
    current.current?.stop();
    current.current = element ? { element, stop: watchStrip(name, element, () => read.current()) } : null;
  });
  useEffect(() => () => {
    current.current?.stop();
    current.current = null;
  }, []);
}
