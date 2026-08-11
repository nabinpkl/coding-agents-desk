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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Bound to every interface rather than loopback only, so the Mac host's webview and an
    // ordinary browser on another machine reach the same server. The phone is NOT one of those
    // surfaces: loading this over http from a tailnet address is refused by App Transport
    // Security, so the phone keeps the bundled build (ADR-0095).
    host: true,
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
      },
    },
  },
});
