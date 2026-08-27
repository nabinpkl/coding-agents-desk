import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Where the sidecar is listening, and the token that lets us talk to its control API.
 *
 * Both come from the environment because both are per-machine and per-run: the port is tier-derived
 * (stable/dev) and the token is minted fresh per sidecar spawn, so neither can be a literal here.
 * They matter only for the plain-browser leg; the webview reaches the sidecar through the relay.
 */
const sidecarOrigin = process.env.AGENTDESK_AGENT_FEED_ORIGIN ?? "http://127.0.0.1:7682";
const controlToken = process.env.AGENT_FEED_CONTROL_TOKEN;

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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
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
      // Only the browser path uses this. Inside the host's webview the panel goes through the
      // relay, which attaches the token itself -- the page never holds it, and that is the whole
      // reason Swift is still in the data path.
      "/api": {
        target: sidecarOrigin,
        changeOrigin: true,
        headers: controlToken ? { authorization: `Bearer ${controlToken}` } : undefined,
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
        configure: (proxy) => {
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
        },
      },
    },
  },
});
