/**
 * Keeps an open panel when its connection to the dev server comes back, rather than reloading it.
 *
 * Vite's client reloads the whole page every time its websocket drops and the server answers again
 * (`vite/dist/client/client.mjs`, the `vite:ws:disconnect` branch). iOS closes a backgrounded
 * page's sockets, so on the iPhone that was a reload on most returns to the panel: every card's
 * scroll and loaded history gone, and Agent Radio heard in the panel (`radioListener.ts`) stopped,
 * with nothing but a tap able to start it again. Measured 2026-10-22 from the panel's own load
 * telemetry: four of the last five loads had a live page before them, which a tab iOS discarded does
 * not.
 *
 * A reload is only needed when the page missed something, so the server numbers what it sends:
 * every update and every full reload, counted where they leave (`hot.send`), after the panel's own
 * gates have decided what travels. Each page is told the number as it connects and after each one.
 * When its socket comes back, the page asks for the number again (`RECONNECT_ROUTE`):
 *
 * - the same, from the same server: it missed nothing, and connects again where it is;
 * - moved, or a different server: it reloads, as Vite would have;
 * - moved while the page holds something a reload would lose (`window.__agentPanelHoldReload`, set
 *   by the panel listening to Agent Radio): it connects again, says that updates are waiting
 *   (`RELOAD_WAITING_EVENT`), and leaves the reload to the reader.
 *
 * It rewrites Vite's client, which is why `reconnectInPlace.test.ts` runs the rewrite on the real
 * file: a Vite that moves those lines fails there, and `patchViteClient` throws rather than serving
 * a client that reloads again without a word.
 */

import { randomUUID } from "node:crypto";
import type { HotPayload, Plugin, ViteDevServer } from "vite";

/** Where a page asks what the server has sent since it started. */
export const RECONNECT_ROUTE = "/@panel-reconnect";
/** The custom event carrying the count, sent to each page as it connects and after each update. */
export const SENT_EVENT = "panel:sent";
/** What the page dispatches on `window` when it kept itself despite updates it missed. */
export const RELOAD_WAITING_EVENT = "agent-panel:reload-waiting";

/** The client's lines this changes, exactly as Vite 8.3 writes them. */
const RECONNECT_LINES = "\t\t\t\t\tawait waitForSuccessfulPing(url.href);\n\t\t\t\t\tlocation.reload();";
const CUSTOM_CASE = 'case "custom":\n\t\t\tawait activeHmrClient.notifyListeners(payload.event, payload.data);';
const FIRST_CONNECT = "transport.connect(createHMRHandler(handleMessage));";

/** What the client runs instead: ask, then connect again or reload. Reads names already in the client. */
const DECIDE = `
let __panelSeen = null;
async function __panelKeepPage() {
\ttry {
\t\tconst answer = await fetch(${JSON.stringify(RECONNECT_ROUTE)}, { cache: "no-store" });
\t\tconst now = await answer.json();
\t\tif (__panelSeen && now.server === __panelSeen.server && now.sent === __panelSeen.sent) return true;
\t\tif (typeof window.__agentPanelHoldReload === "function" && window.__agentPanelHoldReload()) {
\t\t\twindow.__agentPanelReloadWaiting = true;
\t\t\twindow.dispatchEvent(new CustomEvent(${JSON.stringify(RELOAD_WAITING_EVENT)}));
\t\t\treturn true;
\t\t}
\t} catch {}
\treturn false;
}
`;

/** Vite's client with its reload-on-reconnect replaced. Throws when the lines it expects are gone. */
export function patchViteClient(code: string): string {
  for (const [name, anchor] of [
    ["reconnect", RECONNECT_LINES],
    ["custom case", CUSTOM_CASE],
    ["first connect", FIRST_CONNECT],
  ] as const) {
    if (code.split(anchor).length !== 2) {
      throw new Error(`reconnectInPlace: Vite's client no longer has its ${name} lines where this expects them`);
    }
  }
  return code
    .replace(
      RECONNECT_LINES,
      "\t\t\t\t\tawait waitForSuccessfulPing(url.href);\n" +
        "\t\t\t\t\tif (await __panelKeepPage()) transport.connect(createHMRHandler(handleMessage));\n" +
        "\t\t\t\t\telse location.reload();",
    )
    .replace(
      CUSTOM_CASE,
      `case "custom":\n\t\t\tif (payload.event === ${JSON.stringify(SENT_EVENT)}) __panelSeen = payload.data;\n` +
        "\t\t\tawait activeHmrClient.notifyListeners(payload.event, payload.data);",
    )
    .replace(FIRST_CONNECT, `${DECIDE}${FIRST_CONNECT}`);
}

/** Whether a payload changes what a page runs, and so is one it must not miss. */
export function changesPage(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const { type } = payload as { type?: unknown };
  return type === "update" || type === "full-reload";
}

function isViteClient(id: string): boolean {
  return id.split("?", 1)[0]!.endsWith("/vite/dist/client/client.mjs");
}

export function reconnectInPlace(): Plugin {
  // A fresh name per server process: a restarted server has forgotten what it sent, so a page
  // that last heard from another one reloads.
  const server = randomUUID();
  let sent = 0;
  const count = () => ({ server, sent });

  return {
    name: "agent-panel-reconnect-in-place",
    apply: "serve",

    transform(code, id) {
      if (!isViteClient(id)) return undefined;
      return { code: patchViteClient(code), map: null };
    },

    configureServer(dev: ViteDevServer) {
      const hot = dev.environments.client.hot;
      const send = hot.send.bind(hot);
      // Counted where it leaves, so an update a gate holds back is counted when it is let go.
      hot.send = (payload: HotPayload | string, data?: unknown) => {
        if (typeof payload === "string") {
          send(payload, data);
          return;
        }
        send(payload);
        if (!changesPage(payload)) return;
        sent += 1;
        send(SENT_EVENT, count());
      };
      hot.on("vite:client:connect", (_data: unknown, client: { send(event: string, data: unknown): void }) => {
        client.send(SENT_EVENT, count());
      });

      dev.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== RECONNECT_ROUTE) return next();
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify(count()));
      });
    },
  };
}
