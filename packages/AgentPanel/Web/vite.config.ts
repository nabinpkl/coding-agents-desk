import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, watch } from "node:fs";
import { request as httpRequest, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { runtimePaths } from "../../../tools/runtime-paths.mjs";
import {
  indexFor,
  mergeSidecars,
  parseDeclaredPeers,
  parseDescriptor,
  SIDECAR_STALE_MS,
  type LiveSidecar,
} from "./src/app/dev-server/sidecarBoard";
import { proxyToSidecar } from "./src/app/dev-server/sidecarProxy";
import { panelPublish } from "./src/app/dev-server/panelPublish";
import { createTypeHolds, dependentsOf, resend } from "./src/app/dev-server/typeHolds";
import { createSupervisorClient, type Machine } from "./src/app/dev-server/supervisorClient";
import { sourceSignature, sourceVersion } from "../../../agent-feed/sidecar/src/sourceVersion";
import { writePanelActivity } from "../../../agent-feed/sidecar/src/supervisor/supervisorBoard";
import { createTypeBaseline, describeTypeError } from "../../../agent-feed/sidecar/src/supervisor/typecheck";
import { readPublishMode, writePublishMode } from "./src/app/dev-server/publishMode";
import {
  PANEL_BUILD_ROUTE,
  PANEL_COMMAND_PARAM,
  PANEL_PUBLISH_EVENT,
} from "./src/features/profile/panelBuildRoute";

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
const panelSource = fileURLToPath(new URL("./src/", import.meta.url));
/**
 * The page's code typechecked with TypeScript 7, reporting only errors the running page did not
 * already have. Its own project rather than the tests', which is what reaches an open page.
 */
const checkPageTypes = createTypeBaseline(fileURLToPath(new URL("./tsconfig.json", import.meta.url)));
const agentFeedRoot = fileURLToPath(new URL("../../../agent-feed/", import.meta.url));

/**
 * The sidecar code in this tree, hashed the way a sidecar hashes what it started from, so the two
 * compare. Re-hashed only when a stat of the files says something moved: the report is read every
 * couple of seconds, and the hash reads two megabytes where the stat reads none.
 */
let treeVersionFor = { signature: "", version: null as string | null };
function treeVersion(): string | null {
  try {
    const signature = sourceSignature(agentFeedRoot);
    if (signature !== treeVersionFor.signature) {
      treeVersionFor = { signature, version: sourceVersion(agentFeedRoot) };
    }
    return treeVersionFor.version;
  } catch (error) {
    // A tree mid-rename can fail one read. No version means no machine is called behind, which is
    // the quiet answer; the next report tries again.
    console.warn(`[panel] could not hash the sidecar source: ${String(error)}`);
    return null;
  }
}

/**
 * The build id of the tree as it is RIGHT NOW: short commit, `+` when the tree is not exactly it.
 *
 * A function rather than a constant because the answer changes. `define` below substitutes one
 * reading at config load, which is exact for a bundled build and is only the last server restart
 * under `vite dev` -- measured 2026-09-14, the panel showed `f2dffa6+` while HEAD was `7373cec`
 * and the tree was clean. The route serves this per request so a live tab reads the tree instead
 * of the restart, and `panelBuild.ts` carries which of the two each surface is looking at.
 *
 * Both commands together cost about 75ms here, and they run on page load and on each applied
 * update, so there is nothing to cache. A git that cannot answer yields `unknown`, which the row
 * shows: a build that cannot name itself is the same problem this exists to make visible.
 */
function panelBuildId(): string {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  try {
    const head = git(["rev-parse", "--short=7", "HEAD"]);
    // Several sessions share this worktree, so the mark says "this tree was not any one commit",
    // not "you have uncommitted work".
    return git(["status", "--porcelain"]) === "" ? head : `${head}+`;
  } catch {
    return "unknown";
  }
}

/**
 * The default session's sidecar, split for the middleware proxy below.
 *
 * There is no `server.proxy` entry for `/api` any more, and that is the point: Vite's `server.https`
 * turns on TLS AND HTTP/2, but "if the `server.proxy` option is also configured, this setting will
 * downgrade to TLS-only without HTTP/2" (Vite's own server-options doc). Under HTTP/1.1 a browser
 * keeps about six connections per origin, and this panel holds an EventSource for the catalog, the
 * transcript, background tasks, the summary, usage, bots, the session board and the terminals --
 * more streams than connections. The terminal stream is opened last, so it was the one starved: its
 * `onopen` never fired, the screen replay that waits on it was never requested, and the pane sat
 * blank on "Opening terminal" while every other surface worked. Intermittent, because which stream
 * loses depends on what the page opened first.
 *
 * HTTP/2 multiplexes them all over one connection, so the cap stops existing rather than being
 * budgeted around.
 */
const defaultSidecar = (() => {
  const url = new URL(sidecarOrigin);
  return { host: url.hostname, port: Number(url.port || 80) };
})();

/** Only letters, digits and dashes reach a path segment or match a descriptor filename. */
const SESSION_ID = /^[a-z0-9-]+$/i;

/**
 * Sidecars on other machines, which cannot announce themselves.
 *
 * The board is a directory on THIS machine, so a peer elsewhere has no way onto it. Declaring it
 * here is the other half of the same idea: `id=host:port`, comma separated. Env rather than a
 * literal because an address is environment-dependent, the same reason `sidecarOrigin` is.
 */
const declaredPeers = parseDeclaredPeers(process.env.AGENTDESK_PANEL_REMOTE_SIDECARS);

/**
 * What each machine's sidecar supervisor is doing, and the way the reader's choice reaches it.
 *
 * Module scope because it is one fact about this machine's view of the world rather than either
 * plugin's private state, and the two plugins that touch it are built separately: the session
 * plugin knows which machines exist, and the publisher plugin is where a reader's choice arrives.
 */
const supervisorClient = createSupervisorClient();
/** Whether the last write of the panel's activity for the supervisor failed, so it is said once. */
let activityFailing = false;

/** Every machine the panel can reach right now, filled in by the session plugin below. */
let knownMachines: () => Machine[] = () => [];

/**
 * Serves the sidecars the panel can reach: the login sessions on this machine, plus declared peers.
 *
 * A session on this machine announces itself on a shared board (see `announceSidecar`); this reads
 * that board, so a second desktop appears the moment its sidecar starts and vanishes when it stops,
 * with nothing hand-fed to this server. A peer on ANOTHER machine cannot write to that board, so it
 * is declared instead and its liveness is this server reaching it. Three routes:
 *
 *  - `GET /session/index.json` -- a one-shot snapshot of the live set, ids and labels only.
 *  - `GET /session/stream` -- the same set as Server-Sent Events, pushed whenever it changes, so a
 *    session coming up while the page is open shows in the picker without a reload. The subscribe
 *    half of announce/subscribe.
 *  - `/session/<id>/api/...` -- a streaming reverse proxy to that session's sidecar on loopback,
 *    resolved per request so it always follows the live port. The default session is not here: it
 *    answers on `/api`, as every existing caller expects.
 *
 * No entry carries a token, because there is nothing to attach: the sidecar API has no auth of its
 * own anywhere. What stood in for it was the bind address, and the invariant is now UNAUTHENTICATED
 * IMPLIES TAILNET-ONLY rather than loopback-only -- a peer reached over the tailnet is authenticated
 * and encrypted by WireGuard at the device level, which is the guarantee loopback was a proxy for.
 * A sidecar still binds loopback unless `AGENT_FEED_HOST` says otherwise, so nothing widens by
 * accident; do not "fix" a tailnet address here back to 127.0.0.1.
 */
function panelSessions(): Plugin {
  const registryDir = runtimePaths().sidecarRegistry;
  const self = userInfo().username;

  /** When each declared peer was last seen answering. Its heartbeat, since it writes no file. */
  const reachableAt = new Map<string, number>();

  function readBoard(): LiveSidecar[] {
    let files: string[];
    try {
      files = readdirSync(registryDir);
    } catch {
      return []; // no board yet: nothing has announced
    }
    const now = Date.now();
    const board: LiveSidecar[] = [];
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      try {
        const entry = parseDescriptor(JSON.parse(readFileSync(join(registryDir, name), "utf8")), now);
        if (entry) board.push(entry);
      } catch {
        // a descriptor caught mid-write or malformed: skip it; the next read gets it whole
      }
    }
    return board;
  }

  function liveSidecars(): Map<string, LiveSidecar> {
    return mergeSidecars(readBoard(), declaredPeers, reachableAt, Date.now());
  }

  /**
   * Asks each declared peer whether it is there, which is that peer's heartbeat.
   *
   * `/api/config` is the cheapest endpoint that proves a real sidecar answered rather than some
   * other service on that port. A failure just stops refreshing the timestamp, so the peer ages out
   * of the picker by the same rule a silent board session does.
   */
  function probeDeclared(onChange: () => void): void {
    for (const peer of declaredPeers) {
      const probe = httpRequest(
        { host: peer.host, port: peer.port, method: "GET", path: "/api/config", timeout: 4_000 },
        (peerResponse) => {
          peerResponse.resume();
          if (peerResponse.statusCode === 200) {
            reachableAt.set(peer.id, Date.now());
            onChange();
          }
        },
      );
      probe.on("timeout", () => probe.destroy());
      probe.on("error", () => {}); // unreachable: let it age out rather than logging every tick
      probe.end();
    }
  }

  return {
    name: "agent-panel-sessions",
    configureServer(server) {
      const subscribers = new Set<ServerResponse>();
      let lastPushed = "";
      const snapshot = () => JSON.stringify(indexFor(liveSidecars(), self));

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

      // A declared peer has no file to watch, so it is polled on the same clock the board's silence
      // is noticed on. Probing pushes as soon as a peer answers rather than waiting for the next
      // broadcast tick, so a remote machine coming up appears in the picker without a reload.
      if (declaredPeers.length > 0) {
        probeDeclared(broadcast);
        setInterval(() => probeDeclared(broadcast), SIDECAR_STALE_MS / 3).unref?.();
      }

      // What each machine's supervisor is doing, on the same clock and from the same answer the
      // liveness probe already reads. Every live sidecar, this session's included, so the panel's
      // row says the same thing about a peer as it does about the Mac in front of the reader.
      knownMachines = () => [
        { label: self, host: defaultSidecar.host, port: defaultSidecar.port },
        ...[...liveSidecars()].map(([label, entry]) => ({ label, host: entry.host, port: entry.port })),
      ];
      const readSupervisors = () => supervisorClient.refresh(knownMachines(), () => {});
      readSupervisors();
      setInterval(readSupervisors, SIDECAR_STALE_MS / 3).unref?.();

      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        const path = url.split("?")[0] ?? "";
        // The default session -- the one this server runs beside -- answers on `/api` directly.
        // Handled here rather than by `server.proxy` because that option costs the whole origin
        // its HTTP/2 (see `defaultSidecar`), and this plugin already proxies the other sessions.
        if (path.startsWith("/api")) {
          proxyToSidecar(defaultSidecar.host, defaultSidecar.port, url, request, response);
          return;
        }
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
          // No `connection: keep-alive`: HTTP/2 rejects it outright, and it means nothing there --
          // the connection is multiplexed and stays open by definition.
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
        const entry = liveSidecars().get(id);
        if (!entry) {
          response.statusCode = 503;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(`session "${id}" is not reachable (no live sidecar)\n`);
          return;
        }
        proxyToSidecar(entry.host, entry.port, upstreamPath, request, response);
      });
    },
  };
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
  plugins: [
    react(),
    tailwindcss(),
    // Before `panelSessions`, because middleware runs in the order it was added and this one owns
    // the `/@panel-build` route the other used to answer.
    panelPublish({
      buildRoute: PANEL_BUILD_ROUTE,
      event: PANEL_PUBLISH_EVENT,
      commandParam: PANEL_COMMAND_PARAM,
      buildId: panelBuildId,
      // Filled by `panelSessions`, which already asks every sidecar it knows whether it is alive.
      // The publisher reports it because the panel's own held work is reported there, and a reader
      // wants one answer to "is what I am looking at current", not two.
      supervisors: () => supervisorClient.report(treeVersion()),
      // Onto the registry board the sidecar supervisor reads, so a restart waits for the panel's edits
      // to settle as well as its own (`supervisorBoard.ts`).
      recordActivity: (activity) => {
        try {
          writePanelActivity(runtimePaths().sidecarRegistry, activity);
          activityFailing = false;
        } catch (error) {
          // The supervisor then sees no panel and waits on its own tree alone, which is what it does
          // for a peer; worth a line, once, not worth failing an update over. This runs every 2s.
          if (!activityFailing) console.warn(`[panel-publish] could not tell the supervisor what the panel is doing: ${String(error)}`);
          activityFailing = true;
        }
      },
      // Every machine, for a mode and for a restart alike: what a reader means by manual is "stop
      // changing under me", and the Mac and a peer run one tree between them.
      tell: (command) => supervisorClient.tell(knownMachines(), command),
      // Kept across dev server restarts, because a restart is one of the things a reader is asking
      // to be protected from when they choose to hold updates. Each machine's supervisor still
      // starts on auto and is told again by the reconcile above, so a machine whose panel is gone
      // runs normally rather than staying frozen on the word of a process that is not there.
      remembered: () => readPublishMode(runtimePaths().panelPublishMode),
      remember: (mode) => writePublishMode(runtimePaths().panelPublishMode, mode),
      // A whole file goes out once the code it lands among typechecks (`typeHolds.ts`).
      holdTypes: ({ server, publish, log }) => createTypeHolds({
        check: async () => {
          const result = await checkPageTypes();
          if ("failed" in result) return result;
          const fresh = result.fresh.map((error) => ({ file: error.file, reason: describeTypeError(error) }));
          return { fresh, accept: result.accept };
        },
        dependents: (file) => dependentsOf(server(), file),
        send: (files) => resend(server(), files),
        publish,
        log,
      }),
    }),
    panelSessions(),
    vncBridge(),
  ],
  base: "./",
  define: {
    __PANEL_BUILD__: JSON.stringify(panelBuildId()),
  },
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
      // Keyed with the trailing slash on purpose: a bare "@" would also match
      // "@agentdesk/agent-feed-wire" and swallow the wire contract.
      "@/": panelSource,
      "@repo/": fileURLToPath(new URL("../../../", import.meta.url)),
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
  },
});
