import { readdirSync, readFileSync, watch } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { runtimePaths } from "../../../tools/runtime-paths.mjs";

/**
 * Where this session's own sidecar is listening. Per-machine and tier-derived (stable/dev), so it
 * comes from the environment rather than a literal. It matters only for the plain-browser leg; the
 * webview reaches the sidecar through the relay. Other login sessions are discovered off the shared
 * board (see `panelSessions`), not from here.
 */
const sidecarOrigin = process.env.AGENTDESK_AGENT_FEED_ORIGIN ?? "http://127.0.0.1:7682";

/**
 * The tailnet name this server answers to, and the certificate proving it is that name.
 *
 * Both are per-machine, so the Justfile derives them and passes them in. Together they are what
 * lets the PHONE load the panel from here: iOS refuses cleartext HTTP to a tailnet address, and
 * `NSAllowsLocalNetworking` does not cover 100.64/10, so the only way in without an ATS exception
 * in an app that ships to a daily driver is real TLS under a publicly trusted certificate.
 * Tailscale issues exactly that for the MagicDNS name (ADR-0096).
 *
 * TLS is all-or-nothing for the port, which is why there is one origin and not two: with a
 * certificate loaded, `http://127.0.0.1:5173` stops working, so the Mac uses the same https name
 * the phone does rather than each surface having its own idea of where the panel lives.
 */
const tailnetHost = process.env.AGENTDESK_AGENT_PANEL_HOST;
const tlsCertificate = process.env.AGENTDESK_AGENT_PANEL_TLS_CERT;
const tlsKey = process.env.AGENTDESK_AGENT_PANEL_TLS_KEY;
// Read now rather than handing Vite the paths, so a missing or unreadable certificate fails here,
// naming the file, instead of surfacing as a phone that cannot load a page.
const https =
  tlsCertificate && tlsKey
    ? { cert: readFileSync(tlsCertificate), key: readFileSync(tlsKey) }
    : undefined;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const xtermPackage = fileURLToPath(
  new URL("../../../terminal/vendor/xterm/package", import.meta.url),
);
const agentFeedWire = fileURLToPath(
  new URL("../../../agent-feed/wire/index.ts", import.meta.url),
);

/**
 * http-proxy does not tear down the upstream leg when the browser goes away: an aborted fetch kept
 * streaming from the sidecar into the proxy's void, which held live window captures alive with no
 * viewer. Destroying the upstream side when the client side closes is what lets the sidecar see the
 * abort at all. After a normally finished response these destroys are no-ops.
 *
 * The signal for "the browser is gone" is the client RESPONSE closing before it ended. The
 * request's own "close" is a trap: on a GET it fires as soon as the empty body completes, which is
 * immediately, and destroying there killed every proxied request at birth.
 */
const releaseUpstreamWhenClientLeaves: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyReq", (proxyReq, _req, res) => {
    res.on("close", () => {
      if (!res.writableEnded) proxyReq.destroy();
    });
  });
  proxy.on("proxyRes", (proxyRes, _req, res) => {
    res.on("close", () => {
      if (!res.writableEnded) proxyRes.destroy();
    });
  });
};


/** A login session's sidecar as the shared board records it, once liveness has been checked. */
interface LiveSidecar {
  readonly user: string;
  readonly label: string;
  readonly port: number;
}

/** Only letters, digits and dashes reach a path segment or match a descriptor filename. */
const SESSION_ID = /^[a-z0-9-]+$/i;
/** A descriptor older than this has lost its heartbeat; the sidecar behind it is treated as gone. */
const SIDECAR_STALE_MS = 15_000;

/**
 * Serves the login sessions this machine is running, discovered rather than declared.
 *
 * Every sidecar announces itself on a shared board (see `announceSidecar`); this reads that board,
 * so a second desktop appears the moment its sidecar starts and vanishes when it stops, with nothing
 * hand-fed to this server. Three routes:
 *
 *  - `GET /session/index.json` -- a one-shot snapshot of the live set, ids and labels only.
 *  - `GET /session/stream` -- the same set as Server-Sent Events, pushed whenever it changes, so a
 *    session coming up while the page is open shows in the picker without a reload. The subscribe
 *    half of announce/subscribe.
 *  - `/session/<id>/api/...` -- a streaming reverse proxy to that session's sidecar on loopback,
 *    resolved per request so it always follows the live port. The default session is not here: it
 *    answers on `/api`, as every existing caller expects.
 *
 * The board carries ports, not tokens: the sidecar API is unauthenticated on a loopback-bound
 * server behind a tailnet-only panel, so there is nothing to attach.
 */
function panelSessions(): Plugin {
  const registryDir = runtimePaths().sidecarRegistry;
  const self = userInfo().username;

  function readBoard(): Map<string, LiveSidecar> {
    const live = new Map<string, LiveSidecar>();
    let files: string[];
    try {
      files = readdirSync(registryDir);
    } catch {
      return live; // no board yet: nothing has announced
    }
    const now = Date.now();
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(registryDir, name), "utf8")) as Record<string, unknown>;
        const { user, port, heartbeat } = raw;
        if (typeof user !== "string" || !SESSION_ID.test(user)) continue;
        if (typeof port !== "number" || !Number.isInteger(port)) continue;
        if (typeof heartbeat !== "number" || now - heartbeat > SIDECAR_STALE_MS) continue;
        const label = typeof raw.label === "string" && raw.label ? raw.label : user;
        live.set(user, { user, label, port });
      } catch {
        // a descriptor caught mid-write or malformed: skip it; the next read gets it whole
      }
    }
    return live;
  }

  // The default session leads, carries no id (it answers on `/api`), and takes the running account's
  // own label. Every other live session follows, sorted so the picker order does not jump between
  // reads.
  function indexFor(live: Map<string, LiveSidecar>): { id?: string; label: string }[] {
    const others = [...live.values()]
      .filter((entry) => entry.user !== self)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((entry) => ({ id: entry.user, label: entry.label }));
    return [{ label: live.get(self)?.label ?? self }, ...others];
  }

  return {
    name: "agent-panel-sessions",
    configureServer(server) {
      const subscribers = new Set<ServerResponse>();
      let lastPushed = "";
      const snapshot = () => JSON.stringify(indexFor(readBoard()));

      const broadcast = () => {
        const json = snapshot();
        if (json === lastPushed) return;
        lastPushed = json;
        for (const response of subscribers) {
          try {
            response.write(`data: ${json}\n\n`);
          } catch {
            // a dead client is pruned by its own "close"
          }
        }
      };

      // The board changes on two clocks: a file appears or is rewritten (an fs event) and a
      // heartbeat goes silent (no event, only elapsed time). Watch covers the first, a slow interval
      // the second; both funnel through broadcast, which pushes only on a real change.
      let debounce: ReturnType<typeof setTimeout> | undefined;
      try {
        watch(registryDir, () => {
          clearTimeout(debounce);
          debounce = setTimeout(broadcast, 150);
        }).unref?.();
      } catch {
        // the dir is not created until the first sidecar announces; the interval still catches it
      }
      setInterval(broadcast, SIDECAR_STALE_MS / 3).unref?.();

      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        const path = url.split("?")[0] ?? "";
        if (!path.startsWith("/session/")) return next();

        if (path === "/session/index.json") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(snapshot());
          return;
        }

        if (path === "/session/stream") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream; charset=utf-8");
          response.setHeader("cache-control", "no-cache");
          response.setHeader("connection", "keep-alive");
          response.write(`data: ${snapshot()}\n\n`);
          subscribers.add(response);
          request.on("close", () => subscribers.delete(response));
          return;
        }

        const id = /^\/session\/([^/]+)/.exec(path)?.[1];
        if (!id || !SESSION_ID.test(id)) {
          response.statusCode = 404;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(`no such session route "${path}"\n`);
          return;
        }
        const upstreamPath = url.slice(`/session/${id}`.length);
        if (!upstreamPath.startsWith("/api")) {
          // Only the sidecar API belongs to another session; everything else is this origin's.
          response.statusCode = 404;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(`only /api is proxied per session, not "${upstreamPath}"\n`);
          return;
        }
        const entry = readBoard().get(id);
        if (!entry) {
          response.statusCode = 503;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(`session "${id}" is not announced (no live sidecar)\n`);
          return;
        }
        proxyToSidecar(entry.port, upstreamPath, request, response);
      });
    },
  };
}

/**
 * A streaming reverse proxy to a sidecar on loopback.
 *
 * Hand-rolled rather than a library because the target is resolved per request from the live board,
 * which Vite's static `server.proxy` cannot express, and because http-proxy is not a resolvable
 * dependency here. Piping both directions keeps SSE and chunked responses streaming; tearing the
 * upstream down when the client response closes early lets the sidecar see an abandoned live
 * capture, the concern `releaseUpstreamWhenClientLeaves` handles for the default session.
 */
function proxyToSidecar(port: number, path: string, request: IncomingMessage, response: ServerResponse): void {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: request.method,
      path,
      headers: { ...request.headers, host: `127.0.0.1:${port}` },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    if (!response.writableEnded) response.end("session sidecar unreachable\n");
  });
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.pipe(upstream);
}

/**
 * Bridges a WebSocket on this origin to the Mac's Screen Sharing port.
 *
 * A browser cannot open a TCP socket, so a VNC client in the page needs something to relay bytes.
 * Doing it on the panel's own origin means it inherits the tailnet certificate: no second port, no
 * second certificate, and no mixed-content block on a page already served over TLS.
 *
 * This does not widen what is reachable. `screensharingd` already listens on the tailnet, the far
 * side here is pinned to loopback, and authentication stays entirely between macOS and whoever is
 * typing. What it buys is the one thing the desktop viewer cannot do: RFB drives whichever session
 * it is showing, including the login window, so it still works when the console is locked and the
 * capture path can only show a picture nobody can click.
 */
function vncBridge(port = 5900, host = "127.0.0.1"): Plugin {
  return {
    name: "agent-panel-vnc-bridge",
    configureServer(server) {
      const sockets = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (request, socket, head) => {
        // Vite upgrades its own HMR paths on this same server, so anything not ours is left for it
        // rather than refused.
        if (!(request.url ?? "").startsWith("/vnc")) return;
        sockets.handleUpgrade(request, socket as never, head, (ws) => {
          const upstream = connect(port, host);
          const shutdown = () => {
            upstream.destroy();
            if (ws.readyState === ws.OPEN) ws.close();
          };
          upstream.on("data", (chunk) => {
            if (ws.readyState === ws.OPEN) ws.send(chunk);
          });
          upstream.on("error", shutdown);
          upstream.on("close", shutdown);
          ws.on("message", (data) => upstream.write(data as Uint8Array));
          ws.on("error", shutdown);
          ws.on("close", shutdown);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), panelSessions(), vncBridge()],
  base: "./",
  // noVNC uses top-level await, which the default target (es2020) refuses. Raising the target is
  // the smaller change than patching the dependency, and costs nothing here: every browser this
  // panel runs in -- the Mac webview, iOS Safari, a desktop tab -- has supported it for years.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  optimizeDeps: {
    // Left unbundled rather than pre-bundled, so the same top-level await is handled by the browser
    // that already supports it instead of by esbuild, which would have to be retargeted for every
    // dependency to accommodate one.
    exclude: ["@novnc/novnc"],
  },
  resolve: {
    alias: {
      "@agentdesk/agent-feed-wire": agentFeedWire,
      "@xterm/xterm": xtermPackage,
    },
  },
  server: {
    // Bound to every interface rather than loopback only, so the Mac host's webview, the phone
    // over the tailnet, and an ordinary browser all reach the same server.
    host: true,
    fs: { allow: [repositoryRoot] },
    https,
    // Only matters when this server is run by hand without a certificate. Vite's host check exists
    // to stop DNS rebinding, and it installs the middleware only when `https` is unset -- a
    // certificate is the stronger form of the same guarantee, since a rebound name cannot complete
    // the handshake. So under TLS this line is inert, and without TLS it is what lets the MagicDNS
    // name through a check that recognises only localhost and bare IPs on its own.
    allowedHosts: tailnetHost ? [tailnetHost] : [],
    hmr: {
      // Left to the default, which is "connect back to whatever host the page loaded from" -- the
      // reason one server works for localhost and a LAN address with no per-surface config. Set
      // the variable only when the page's origin is not reachable for the websocket, e.g. behind
      // a proxy.
      host: process.env.AGENTDESK_AGENT_PANEL_HMR_HOST,
    },
    proxy: {
      // The default session -- the one the panel runs in -- answers here. Other sessions are proxied
      // per request by the `panelSessions` plugin, which resolves each from the live board. Only the
      // browser path uses this; inside the host's webview the panel goes through the relay.
      "/api": {
        target: sidecarOrigin,
        changeOrigin: true,
        // http-proxy does not tear down the upstream leg when the browser goes
        // away: an aborted fetch kept streaming from the sidecar into the
        // proxy's void, which held live window captures alive with no viewer.
        // Destroying the upstream side when the client side closes is what
        // lets the sidecar see the abort at all. After a normally finished
        // response these destroys are no-ops.
        // The signal for "the browser is gone" is the client RESPONSE
        // closing before it ended. The request's own "close" is a trap: on a
        // GET it fires as soon as the empty body completes, which is
        // immediately, and destroying there killed every proxied request at
        // birth.
        configure: releaseUpstreamWhenClientLeaves,
      },
    },
  },
});
