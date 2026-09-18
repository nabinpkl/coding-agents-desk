#!/usr/bin/env bun
// Reverse proxy in front of proxy-agent-server's loopback observer API (127.0.0.1:9155), so a
// remote-sidecar peer reachable only over tailscale can still reach it.
//
// Why this exists rather than exposing 9155 to the tailnet directly: proxy-agent-server's own
// `enforce_local_request` middleware (crates/proxy-agent-server/src/observer_api/router.rs)
// rejects any request whose Host header does not parse as a literal IPv4 loopback address --
// deliberate DNS-rebinding hardening for its declared "loopback-only, one trusted local user"
// boundary. `tailscale serve --tcp` forwards raw bytes and cannot rewrite that header; `--http`
// mode passes the CLIENT's original Host through unchanged. Neither gets past the check, and
// proxy-agent's own code is intentionally not the thing to change here -- this relay is a
// legitimate loopback caller as far as proxy-agent-server is concerned, and the tailnet (peer
// identity over WireGuard) is the actual auth boundary on this side, matching the model
// `remote-sidecar.sh` already uses for the transcript sidecar.
//
// Streams the response body straight through unbuffered -- required for the SSE event stream at
// /v1/viewer/streams/{id}/events, which is long-lived and must forward each delta as it arrives.

const LISTEN_PORT = Number(process.env.PROXY_OBSERVER_RELAY_PORT ?? 9156);
const UPSTREAM = process.env.PROXY_OBSERVER_UPSTREAM ?? "http://127.0.0.1:9155";
const UPSTREAM_HOST = new URL(UPSTREAM).host;

Bun.serve({
  hostname: "127.0.0.1",
  port: LISTEN_PORT,
  // The SSE events stream at /v1/viewer/streams/{id}/events is meant to stay open indefinitely,
  // idle between deltas -- Bun's default 10s per-request idle timeout tore it down mid-wait
  // (measured directly: "[Bun.serve]: request timed out after 10 seconds" in this relay's own
  // log, immediately on first use). 0 disables it.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM);
    const headers = new Headers(request.headers);
    headers.set("host", UPSTREAM_HOST);
    try {
      return await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        // @ts-expect-error Bun-specific: required to stream a request body through.
        duplex: request.body ? "half" : undefined,
      });
    } catch (error) {
      console.error(`proxy-observer-relay-upstream-error: ${String(error)}`);
      return new Response("upstream unreachable", { status: 502 });
    }
  },
});

console.log(`proxy-observer-relay listening on :${LISTEN_PORT}, forwarding to ${UPSTREAM}`);
