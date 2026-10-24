/**
 * Who may open a WebSocket on the panel's dev server that Vite does not own: today the Screen
 * surface's `/vnc` bridge to macOS Screen Sharing (`vncBridge` in `vite.config.ts`).
 *
 * A WebSocket is not held to the same-origin rules a fetch is. Any page open in the reader's browser
 * can open one to this server, at loopback or at the tailnet name, and the browser carries the bytes
 * both ways. So the server decides, by the same two rules the sidecar's `requestGuard.ts` applies to
 * its routes:
 *
 * - The Host must be this server's own: an IP literal, `localhost`, or the panel's name
 *   (`AGENTDESK_AGENT_PANEL_HOST`, the tailnet or local network name it is served under). A page
 *   whose name an attacker points at this Mac (DNS rebinding) still sends its own name, and is
 *   refused.
 * - The page that asked must be this origin: its Origin's host and port are the Host. A browser
 *   always sends Origin on a WebSocket and a page cannot forge it. A request with no Origin at all
 *   comes from something that is not a browser, which reaches this server no differently than it
 *   reaches Screen Sharing itself.
 *
 * Vite checks the origin of its own hot-reload socket, and the sidecar's routes sit behind
 * `requestGuard.ts`, so this covers the upgrade the panel's config adds.
 */

import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Why an upgrade must be refused, or null to let it through. */
export function upgradeRefusal(headers: IncomingHttpHeaders, panelHost: string | undefined): string | null {
  const host = headers.host;
  const hostname = host ? hostnameOf(host) : null;
  if (!host || !hostname) return "no Host";
  const ours = isIP(hostname) !== 0 || hostname === "localhost" || hostname === panelHost?.toLowerCase();
  if (!ours) return `host not allowed: ${hostname}`;
  const origin = headers.origin;
  if (origin === undefined) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return `origin not allowed: ${origin}`;
  }
  if (originHost !== host.toLowerCase()) return `origin not allowed: ${origin}`;
  return null;
}

/** Answers a refused upgrade with a 403 and closes it, rather than leaving the socket hanging. */
export function refuseUpgrade(socket: Duplex, reason: string): void {
  // Closed once the answer is written, so the 403 reaches the client rather than a reset.
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}\n`);
}
