// The dev server's reverse proxy to a sidecar.
//
// In the panel tree rather than in `vite.config.ts` so a test can drive it over real sockets: the
// config module reads the environment, the TLS files and the session board as it loads, and the
// proxy's whole contract is about what happens to connections, which no mock of one can show.

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Headers that describe ONE hop and must not be forwarded.
 *
 * Required rather than tidy, in both directions. Writing `connection: keep-alive` into an HTTP/2
 * response throws ERR_HTTP2_INVALID_CONNECTION_HEADERS, and the sidecar sends exactly that on
 * every SSE stream; and an HTTP/2 REQUEST arrives carrying its pseudo-headers (`:method`,
 * `:path`, `:scheme`, `:authority`) in the same map as the ordinary ones, which Node's HTTP/1.1
 * client rejects outright with "Header name must be a valid HTTP token". Both were measured the
 * first time this origin negotiated h2.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEnd<T extends Record<string, unknown>>(headers: T): Partial<T> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(":")) continue;
    if (!HOP_BY_HOP.has(name.toLowerCase())) kept[name] = value;
  }
  return kept as Partial<T>;
}

/**
 * A streaming reverse proxy to a sidecar, on loopback or across the tailnet.
 *
 * The only proxy on the dev origin, for every session including the default one: `server.proxy`
 * would cost the origin its HTTP/2 (see `defaultSidecar` in `vite.config.ts`), and it could not
 * express a target resolved per request from the live board anyway.
 *
 * Piping both directions keeps SSE and chunked responses streaming. Tearing the upstream down when
 * the client response closes early is what lets the sidecar see an abandoned live capture: an
 * aborted fetch used to keep streaming into the proxy's void, holding window captures alive with no
 * viewer. The signal is the client RESPONSE closing before it ended -- the request's own "close" is
 * a trap, since on a GET it fires as soon as the empty body completes, which killed every proxied
 * request at birth when it was tried.
 */
export function proxyToSidecar(
  host: string,
  port: number,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const upstream = httpRequest(
    {
      host,
      port,
      method: request.method,
      path,
      // The upstream's own authority, not the panel's: the browser sent this origin's Host header,
      // and passing it through would tell the sidecar it is being addressed as the dev server.
      headers: { ...endToEnd(request.headers), host: `${host}:${port}` },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, endToEnd(upstreamResponse.headers));
      // Flushed before the first event, so a stream the client is waiting on is answered as soon
      // as the upstream answers rather than when its first chunk happens to arrive.
      response.flushHeaders?.();
      upstreamResponse.pipe(response);
      // An upstream that stops mid-body -- a `bun --watch` reload does it to every open stream --
      // emits `close` without `end`, and `pipe` only ends its destination on `end`. So the client
      // was left connected to nothing, and an `EventSource` reconnects only on an error or an end:
      // measured, a proxied stream sat silent for fifty minutes while the direct one had ended at
      // once. Destroyed WITH an error rather than ended, so a cut-short body reads as a failure at
      // the far end rather than as a shorter success: over HTTP/2 a bare `destroy()` closes the
      // stream as cleanly as `end()` does, measured as curl exiting 0 on a truncated stream.
      upstreamResponse.on("close", () => {
        if (upstreamResponse.complete || response.writableEnded) return;
        response.destroy(new Error("the sidecar closed the response before it finished"));
      });
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    if (!response.writableEnded) response.end("session sidecar unreachable\n");
    // The rest of the client's body is read and dropped. A sidecar that goes away mid-upload (a
    // `bun --watch` reload) leaves it with nothing reading it, so the client's upload stalls on flow
    // control and a browser waits for it to finish before it reports the answer: measured, a fetch
    // through this proxy was still pending after fifteen seconds, which on the phone is a send
    // button spinning for good. A phone's slow uplink is what makes that window wide.
    request.resume();
  });
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.pipe(upstream);
}
