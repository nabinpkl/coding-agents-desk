// `POST /api/panel/scroll-diagnostics` -- what a panel page saw move its canvas strips, appended to
// `<user>-panel-scroll.log` beside this process's own log.
//
// Here so one open question can be answered from the reader's own tab: why a strip is found at its
// far end after the panel or this sidecar restarts. The page records the moves and their causes
// (`features/scroll-diagnostics/scrollDiagnostics.ts`); this only checks and writes them. Every
// kind is named below, so a page that drifts from the contract is refused rather than logged.
//
// One line per event: this process's clock, the page's clock, the page's id, the kind, and the
// rest as JSON. The page's clock is the one to order by -- a batch held through a restart arrives
// late -- and this process's is what lines up with the supervisor's restart lines.

import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimePaths } from "@repo/tools/runtime-paths.mjs";
import { ensureCrossSessionDirectory } from "@/crossSessionDirectory";
import type { RouteHandler } from "@/http/protocol/route";

const ROUTE = "/api/panel/scroll-diagnostics";

export const PANEL_SCROLL_KINDS: ReadonlySet<string> = new Set([
  "page.load",
  "page.hide",
  "page.hidden",
  "page.visible",
  "hmr.update",
  "hmr.full-reload",
  "hmr.disconnect",
  "hmr.connect",
  "streams.down",
  "streams.up",
  "strip.attach",
  "strip.detach",
  "strip.scroll",
  "strip.settle",
  "strip.resize",
  "strip.restore",
  "strip.hold",
  "strip.release",
  "strip.store",
  "buffer.dropped",
]);

const MAX_EVENTS = 2000;
const MAX_LINE = 2000;

/** The lines a batch becomes, or a reason it is refused. */
export function panelScrollLines(body: unknown, now = new Date()): string[] | string {
  const { page, events } = (body ?? {}) as { page?: unknown; events?: unknown };
  if (typeof page !== "string" || !/^[a-z0-9]{1,16}$/.test(page)) return "page must be a short id";
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return `events must be an array of at most ${MAX_EVENTS}`;
  const lines: string[] = [];
  for (const event of events) {
    const { t, kind, ...rest } = (event ?? {}) as { t?: unknown; kind?: unknown };
    if (typeof t !== "number" || !Number.isFinite(t)) return "every event needs a numeric t";
    if (typeof kind !== "string" || !PANEL_SCROLL_KINDS.has(kind)) return `unknown kind ${String(kind).slice(0, 40)}`;
    const line = `${now.toISOString()} ${new Date(t).toISOString()} page=${page} ${kind} ${JSON.stringify(rest)}`;
    lines.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
  }
  return lines;
}

/** @param file where the lines go. The runtime path unless a test says otherwise. */
export function createPanelScrollRoutes(file?: string): RouteHandler {
  let target = file;
  return (request, url) => {
    if (request.method !== "POST" || url.pathname !== ROUTE) return undefined;
    return request.json().then(
      (body) => {
        const lines = panelScrollLines(body);
        if (typeof lines === "string") return new Response(lines, { status: 400 });
        if (target === undefined) {
          target = runtimePaths().panelScrollLog;
          ensureCrossSessionDirectory(dirname(target));
        }
        // A write that fails is a 500 the page keeps its batch for, not a 204 that loses it.
        if (lines.length > 0) appendFileSync(target, `${lines.join("\n")}\n`);
        return new Response(null, { status: 204 });
      },
      () => new Response("expected a JSON body", { status: 400 }),
    );
  };
}
