/**
 * Where the panel's dev server can be reached from, chosen by `AGENTDESK_PANEL_LISTEN`.
 *
 * The panel has no login of its own, and whoever can load it can drive this Mac's terminals, its
 * agent sessions and its desktop, so the network it can be reached on is its whole trust boundary.
 * It used to listen on every interface (`host: true`) and leave a pf rule to turn the local network
 * away, but that rule covered IPv4 alone: the Wi-Fi reached it over IPv6 (found 2026-10-23). A server
 * that listens only where it is meant to be reached needs no firewall to be right, so the scope is
 * a choice made here, and the default is the narrowest one.
 *
 * - `loopback` (the default): this Mac only, over plain http. Nothing to set up, and the right answer
 *   for a first run.
 * - `tailnet`: this Mac's tailnet address and its loopback, over https under the tailnet name's
 *   certificate. What a phone needs. The address is the one the tailnet name resolves to, so it is
 *   exactly the address a client asking for that name is given, and it is checked to be a tailnet
 *   address, so a name that resolves somewhere else stops the server instead of putting it on that
 *   network. Loopback stays for what runs on this Mac and is not about transport, the Chrome for
 *   Testing checks among them. IPv4 only on the tailnet: a client that tries the name's IPv6 tailnet
 *   address first is refused at once and falls back.
 * - `network`: every network this Mac is on, over plain http. For a phone without Tailscale, on a
 *   network you trust: anyone on it can load the panel, and a phone's browser treats plain http as
 *   insecure, so it withholds the microphone and notifications there.
 */

import { lookup } from "node:dns/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import type { Plugin } from "vite";

export const LOOPBACK = "127.0.0.1";

export const LISTEN_MODES = ["loopback", "tailnet", "network"] as const;
export type ListenMode = (typeof LISTEN_MODES)[number];

/** Answers with the mode the server is running in, so a launcher reuses it only in the mode asked for. */
export const LISTEN_MODE_ROUTE = "/@agentdesk/listen-mode";

export interface ListenAddresses {
  mode: ListenMode;
  /** What Vite itself listens on: `server.host`, where `true` is every interface. */
  host: string | true;
  /** Further addresses on the same port, whose connections the same server answers. */
  also: string[];
}

export type ResolveIPv4 = (name: string) => Promise<string>;

const resolveIPv4: ResolveIPv4 = async (name) => (await lookup(name, { family: 4 })).address;

export function parseListenMode(value: string | undefined): ListenMode {
  const mode = value === undefined || value === "" ? "loopback" : value;
  if (!(LISTEN_MODES as readonly string[]).includes(mode)) {
    throw new Error(`AGENTDESK_PANEL_LISTEN must be one of ${LISTEN_MODES.join(", ")}, not "${mode}"`);
  }
  return mode as ListenMode;
}

/** Tailscale's addresses are 100.64.0.0/10. */
export function isTailnetAddress(address: string): boolean {
  const octets = address.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) {
    return false;
  }
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return first === 100 && second >= 64 && second <= 127;
}

export async function listenAddresses(
  mode: ListenMode,
  tailnetName: string | undefined,
  resolve: ResolveIPv4 = resolveIPv4,
): Promise<ListenAddresses> {
  if (mode === "loopback") return { mode, host: LOOPBACK, also: [] };
  if (mode === "network") return { mode, host: true, also: [] };
  if (!tailnetName) {
    throw new Error("tailnet mode needs the panel's tailnet name (AGENTDESK_AGENT_PANEL_HOST); start it through just");
  }
  let address: string;
  try {
    address = await resolve(tailnetName);
  } catch (error) {
    throw new Error(
      `the panel's tailnet name ${tailnetName} does not resolve, so there is no tailnet address to ` +
        "listen on: Tailscale must be running, with MagicDNS on",
      { cause: error },
    );
  }
  if (!isTailnetAddress(address)) {
    throw new Error(
      `the panel's tailnet name ${tailnetName} resolves to ${address}, which is not a tailnet address ` +
        "(100.64.0.0/10), so the dev server will not listen there",
    );
  }
  return { mode, host: address, also: [LOOPBACK] };
}

/**
 * Listens on each further address at `server`'s port and hands every connection to `server`, so
 * TLS, HTTP/2 and websocket upgrades all run through the one server Vite built. Resolves once every
 * address is listening; rejects, closing any already open, if one cannot. They close with `server`.
 */
export async function listenAlso(server: Server, addresses: readonly string[]): Promise<Server[]> {
  const port = (server.address() as AddressInfo).port;
  const listening: Server[] = [];
  try {
    for (const address of addresses) {
      const extra = createServer((socket) => server.emit("connection", socket));
      await new Promise<void>((resolve, reject) => {
        extra.once("error", reject);
        extra.listen(port, address, () => {
          extra.off("error", reject);
          resolve();
        });
      });
      listening.push(extra);
    }
  } catch (error) {
    for (const extra of listening) extra.close();
    throw error;
  }
  server.once("close", () => {
    for (const extra of listening) extra.close();
  });
  return listening;
}

/** The Vite side: answers `LISTEN_MODE_ROUTE`, and once Vite is listening, listens on `also` as well. */
export function panelListen(listen: ListenAddresses): Plugin {
  return {
    name: "agentdesk-panel-listen",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(LISTEN_MODE_ROUTE, (_request, response) => {
        response.setHeader("content-type", "text/plain");
        response.end(listen.mode);
      });
      const http = server.httpServer;
      if (!http || listen.also.length === 0) return;
      http.once("listening", () => {
        listenAlso(http, listen.also).catch((error: unknown) => {
          // Vite is already serving on its own address by now. A server that answers on the tailnet
          // but not on loopback looks healthy from the phone while every check on this Mac fails, so
          // it stops instead, saying why.
          server.config.logger.error(
            `agent panel dev server: could not also listen on ${listen.also.join(", ")}: ${String(error)}`,
          );
          process.exit(1);
        });
      });
    },
  };
}
