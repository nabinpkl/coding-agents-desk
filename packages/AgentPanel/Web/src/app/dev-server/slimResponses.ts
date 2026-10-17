// Makes what the dev server sends small enough for a phone to load.
//
// Measured on 2026-10-17 from a cold load in Chrome on the iPhone: 536 files, 37.4MB, 40.8s before
// the panel was ready, at about 770KB/s over the tailnet. 26MB of that was source maps, because Vite
// appends every module's map to the module itself as base64 (it does so even for a module with no
// map of its own, generating one that carries the whole source again), and there is no setting to
// stop it. The rest went uncompressed, since Vite's dev server compresses nothing.
//
// So each whole response is caught at `end`, its inline map is swapped for a link to the same map
// served from `MAP_ROUTE`, which a browser fetches only when developer tools are open, and the body
// is compressed. Measured on the same 536 files: 11.3MB without the maps, 2.9MB gzipped.
//
// It is a middleware, not a `server.proxy` setting, because that option costs the whole origin its
// HTTP/2 (AGENTS.md, "The dev origin serves HTTP/2"). And it leaves alone anything that streams --
// the `/api` and `/session/` proxies, and any response written in pieces -- because a compressor
// holds bytes back until it has enough of them, which would stall every event stream it touched.

import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Connect, Plugin } from "vite";

/** Where a module's source map is served once it is no longer inside the module. */
export const MAP_ROUTE = "/@panel-source-map";

/** Paths whose responses stream, and so must reach the client the moment they are written. */
const STREAMED = ["/api", "/session/"];

/** Below this a body costs about as much to compress as it saves. */
const MIN_COMPRESS_BYTES = 1024;

/** Brotli's quality 4: within 2% of gzip's default size here, in two thirds of its time. */
const BROTLI_QUALITY = 4;

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/;
const INLINE_JS_MAP = /\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/;
const INLINE_CSS_MAP = /\n\/\*# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+) \*\/\s*$/;

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

type Respond = (error: Error) => void;

/**
 * A module's map, keyed by its URL without Vite's `t` timestamp, so an edited module replaces its
 * own entry rather than adding one per save: the store holds one map per module the page has
 * loaded, and per dependency version, since re-bundling dependencies changes their `v`. It lives as
 * long as the dev server does. Developer tools ask for a map just after loading its module, so the
 * newest is the one that matches.
 */
export function createMapStore() {
  const maps = new Map<string, string>();
  return {
    put(moduleUrl: string, base64: string): string {
      const key = withoutTimestamp(moduleUrl);
      maps.set(key, base64);
      return `${MAP_ROUTE}?for=${encodeURIComponent(key)}`;
    },
    get(key: string): Buffer | undefined {
      const base64 = maps.get(key);
      return base64 === undefined ? undefined : Buffer.from(base64, "base64");
    },
  };
}

type MapStore = ReturnType<typeof createMapStore>;

function withoutTimestamp(url: string): string {
  return url.replace(/([?&])t=\d+&?/, "$1").replace(/[?&]$/, "");
}

/** The code with its inline map moved to the store, and a link to it in the map's place. */
export function moveInlineMap(code: string, moduleUrl: string, store: MapStore): string {
  const js = INLINE_JS_MAP.exec(code);
  if (js) return `${code.slice(0, js.index)}\n//# sourceMappingURL=${store.put(moduleUrl, js[1]!)}`;
  const css = INLINE_CSS_MAP.exec(code);
  if (css) return `${code.slice(0, css.index)}\n/*# sourceMappingURL=${store.put(moduleUrl, css[1]!)} */`;
  return code;
}

/** The encoding to send, from what the request accepts: brotli first, then gzip, else none. */
export function chooseEncoding(acceptEncoding: string | string[] | undefined): "br" | "gzip" | null {
  const accepted = (Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding ?? "")
    .split(",")
    .map((part) => part.trim().split(";"))
    .filter(([, quality]) => quality?.trim() !== "q=0")
    .map(([name]) => name!.trim().toLowerCase());
  if (accepted.includes("br")) return "br";
  if (accepted.includes("gzip")) return "gzip";
  return null;
}

async function encode(body: Buffer, encoding: "br" | "gzip"): Promise<Buffer> {
  if (encoding === "br") {
    return brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
  }
  return deflate(body);
}

/** Sends a finished body: compressed when the request takes it and it is worth compressing. */
async function sendBody(request: IncomingMessage, response: ServerResponse, body: Buffer, end: ServerResponse["end"], callback?: () => void): Promise<void> {
  const encoding = body.length >= MIN_COMPRESS_BYTES ? chooseEncoding(request.headers["accept-encoding"]) : null;
  const vary = String(response.getHeader("vary") ?? "");
  if (!/accept-encoding/i.test(vary)) response.setHeader("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  const sent = encoding ? await encode(body, encoding) : body;
  if (encoding) response.setHeader("content-encoding", encoding);
  response.setHeader("content-length", sent.length);
  // `call` on an overloaded method resolves against its last overload, so name the one meant.
  (end as (this: ServerResponse, chunk: Buffer, done?: () => void) => ServerResponse).call(response, sent, callback);
}

/**
 * Wraps one response so that a body handed whole to `end` is slimmed on its way out.
 *
 * A response that calls `write` first is streaming, and from then on the wrapper steps aside, so
 * nothing written in pieces is ever held back. So is anything that is not a 200, already encoded,
 * or not text.
 */
export function slimResponse(request: IncomingMessage, response: ServerResponse, store: MapStore, fail: Respond): void {
  const end = response.end;
  const write = response.write;
  const restore = () => {
    response.end = end;
    response.write = write;
  };
  response.write = function (this: ServerResponse, ...args: unknown[]) {
    restore();
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse["write"];
  response.end = function (this: ServerResponse, chunk?: unknown, encodingOrCallback?: unknown, maybeCallback?: unknown) {
    restore();
    const callback = (typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback) as (() => void) | undefined;
    const type = String(response.getHeader("content-type") ?? "");
    // `isView` rather than `instanceof Uint8Array`, which a Buffer from another realm fails.
    const whole = typeof chunk === "string" || ArrayBuffer.isView(chunk);
    if (!whole || response.statusCode !== 200 || response.getHeader("content-encoding") || !COMPRESSIBLE.test(type)) {
      return (end as (...a: unknown[]) => ServerResponse).call(this, chunk, encodingOrCallback, maybeCallback);
    }
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : "utf8")
      : Buffer.from((chunk as ArrayBufferView).buffer, (chunk as ArrayBufferView).byteOffset, (chunk as ArrayBufferView).byteLength);
    // Only a script or a stylesheet is read as text, to move its map; Vite sends both as UTF-8.
    // Anything else is compressed byte for byte, whatever its charset.
    const body = /javascript|css/.test(type)
      ? Buffer.from(moveInlineMap(bytes.toString("utf8"), request.url ?? "", store), "utf8")
      : bytes;
    sendBody(request, response, body, end, callback).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    return this;
  } as ServerResponse["end"];
}

/** Answers `MAP_ROUTE` from the store, or says plainly that the map is not held. */
function serveMap(request: IncomingMessage, response: ServerResponse, store: MapStore, fail: Respond): void {
  const key = new URL(request.url ?? "", "http://panel").searchParams.get("for") ?? "";
  const map = store.get(key);
  if (!map) {
    response.statusCode = 404;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(`no source map held for "${key}": the dev server has not sent that module since it started\n`);
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-cache");
  sendBody(request, response, map, response.end).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
}

/** The middleware itself, apart from the plugin so a test can stand it up on a bare server. */
export function slimResponsesMiddleware(store: MapStore = createMapStore()): Connect.NextHandleFunction {
  return (request, response, next) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    const fail: Respond = (error) => {
      // The body was already taken from whoever sent it, so the only honest answer is a broken
      // response and a line saying why; sending it uncompressed instead would hide the bug.
      console.error(`[slim-responses] could not send ${request.url}: ${error.message}`);
      if (!response.headersSent) response.statusCode = 500;
      response.destroy(error);
    };
    if (path === MAP_ROUTE) return serveMap(request, response, store, fail);
    if (!STREAMED.some((prefix) => path.startsWith(prefix))) slimResponse(request, response, store, fail);
    next();
  };
}

/**
 * The plugin. First in the plugin list, because a middleware added in `configureServer` runs in
 * plugin order and has to wrap the response before anything else answers it.
 */
export function slimResponses(): Plugin {
  return {
    name: "agent-panel-slim-responses",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(slimResponsesMiddleware());
    },
  };
}
