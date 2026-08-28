// `GET /api/park/tile/:windowID/stream` -- one window as a live fMP4 body.
//
// The response body is exactly what Media Source Extensions eats: an
// initialization segment followed by media segments, forever. Nothing in this
// file understands video. It subscribes to the shared per-window encoder pool
// (see tileEncoderPool.ts for why sharing is load-bearing, not an
// optimization) and copies segments through.
//
// The codec string travels as a response HEADER rather than in the body,
// because the page needs it to construct the SourceBuffer before it can append
// a single byte. That means the response does not resolve until the encoder
// has produced its first segment, which is the one place this path
// deliberately waits -- bounded by the pool's init deadline, because an
// unbounded wait here once turned into a page stuck on "connecting" with
// nothing to diagnose.

import { helperBinary, missingHelperMessage } from "../desktop/helperBinary.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";
import {
  createTileEncoderPool,
  frames,
  TileEncoderError,
  type EncoderProcess,
} from "./tileEncoderPool.ts";

/** The target is a window id, or the literal `display` for the whole screen. */
const TILE_ROUTE = /^\/api\/park\/tile\/(\d{1,10}|display)\/stream$/;

export interface TileOptions {
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  segmentSeconds?: number;
}

function bounded(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}

function encoderArguments(windowID: string, options: TileOptions): string[] {
  const args = windowID === "display" ? ["--display", "main"] : ["--window", windowID];
  if (options.width) args.push("--width", String(Math.round(options.width)));
  if (options.height) args.push("--height", String(Math.round(options.height)));
  if (options.fps) args.push("--fps", String(Math.round(options.fps)));
  if (options.bitrate) args.push("--bitrate", String(Math.round(options.bitrate)));
  if (options.segmentSeconds) args.push("--segment", String(options.segmentSeconds));
  return args;
}

function spawnEncoder(binary: string, args: string[]): EncoderProcess {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    frames: frames(child.stdout as ReadableStream<Uint8Array>),
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already gone. Nothing to do and nothing to report.
      }
    },
    failureDetail: () => new Response(child.stderr as ReadableStream).text(),
  };
}

async function tile(
  pool: ReturnType<typeof createTileEncoderPool>,
  windowID: string,
  options: TileOptions,
  signal: AbortSignal,
): Promise<Response> {
  const { path: binary, mtimeMs, exists } = helperBinary();
  if (!exists) {
    return jsonResponse(
      { code: "tile-encoder-missing", message: missingHelperMessage(binary) },
      503,
    );
  }

  const args = encoderArguments(windowID, options);
  let subscription;
  try {
    // The installed stamp rides in the key so an updated helper is a DIFFERENT encoder rather than a
    // cache hit on the old process. Without it, `just grid-encoder-install` would appear to do
    // nothing for as long as one subscriber kept the previous binary alive.
    subscription = await pool.acquire(`${binary}\u0000${mtimeMs}\u0000${args.join("\u0000")}`);
  } catch (error) {
    if (error instanceof TileEncoderError) {
      return jsonResponse({ code: error.code, message: error.message }, 502);
    }
    throw error;
  }
  const { codec, init, segments, release } = subscription;
  signal.addEventListener("abort", release, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(init);
    },
    async pull(controller) {
      const next = await segments.next();
      if (next.done) {
        controller.close();
        release();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel() {
      release();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      // The page reads this to build its SourceBuffer. Derived from the stream
      // the encoder actually produced, never assumed.
      "x-agentdesk-codec": codec,
      "cache-control": "no-store",
    },
  });
}

export function createTileRoutes(): RouteHandler {
  // The pool key doubles as the spawn command line, NUL-separated because a
  // path may contain spaces and an argument never contains NUL. The second
  // field is the binary's build stamp, which identifies the encoder without
  // being passed to it.
  const pool = createTileEncoderPool((key) => {
    const [binary, _mtimeMs, ...args] = key.split("\u0000");
    return spawnEncoder(binary!, args);
  });
  return (request, url) => {
    if (request.method !== "GET") return undefined;
    const match = TILE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const options: TileOptions = {
      width: bounded(url.searchParams.get("width"), 16, 7680),
      height: bounded(url.searchParams.get("height"), 16, 4320),
      fps: bounded(url.searchParams.get("fps"), 1, 60),
      bitrate: bounded(url.searchParams.get("bitrate"), 100_000, 40_000_000),
      segmentSeconds: bounded(url.searchParams.get("segment"), 0.1, 4),
    };
    // Reported rather than thrown. An unhandled throw here becomes a bare 500
    // with an empty body, which tells the page nothing and cost real time to
    // diagnose once already.
    return tile(pool, match[1]!, options, request.signal).catch((error: unknown) =>
      jsonResponse(
        {
          code: "tile-failed",
          message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        500,
      ),
    );
  };
}
