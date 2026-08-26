// `GET /api/park/tile/:windowID/stream` -- one window as a live fMP4 body.
//
// The response body is exactly what Media Source Extensions eats: an
// initialization segment followed by media segments, forever. Nothing in this
// file understands video. It spawns the grid encoder, de-frames its stdout, and
// copies the payloads through.
//
// Backpressure needs no code. If the reader stops, the response stream stops
// being pulled, we stop reading the child's stdout, its pipe fills, its write
// blocks, and it stops capturing. That chain is the entire flow-control design,
// and it is why this endpoint has no pacer, no queue, and no frame policy.
//
// The codec string travels as a response HEADER rather than in the body, because
// the page needs it to construct the SourceBuffer before it can append a single
// byte. That means the response does not resolve until the encoder has produced
// its first segment, which is the one place this path deliberately waits.

import { config } from "../config.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const TILE_ROUTE = /^\/api\/park\/tile\/(\d{1,10})\/stream$/;

/** Matches the encoder's `[1 byte kind][4 bytes big-endian length][payload]`. */
const KIND_META = 0;
const KIND_INIT = 1;
const KIND_MEDIA = 2;

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
  const args = ["--window", windowID];
  if (options.width) args.push("--width", String(Math.round(options.width)));
  if (options.height) args.push("--height", String(Math.round(options.height)));
  if (options.fps) args.push("--fps", String(Math.round(options.fps)));
  if (options.bitrate) args.push("--bitrate", String(Math.round(options.bitrate)));
  if (options.segmentSeconds) args.push("--segment", String(options.segmentSeconds));
  return args;
}

interface Framed {
  kind: number;
  payload: Uint8Array;
}

/**
 * De-frames the encoder's stdout into `{kind, payload}`.
 *
 * A pull-based generator rather than a pump into a queue, so that not consuming
 * it is what applies backpressure rather than something that has to be
 * detected.
 */
async function* frames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Framed> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  for (;;) {
    // Enough for a header?
    while (buffer.length >= 5) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(1);
      if (buffer.length < 5 + length) break;
      yield { kind: buffer[0]!, payload: buffer.slice(5, 5 + length) };
      buffer = buffer.slice(5 + length);
    }
    const { value, done } = await reader.read();
    if (done) return;
    if (!value) continue;
    const grown = new Uint8Array(buffer.length + value.length);
    grown.set(buffer);
    grown.set(value, buffer.length);
    buffer = grown;
  }
}

async function tile(windowID: string, options: TileOptions, signal: AbortSignal): Promise<Response> {
  const binary = config.gridEncoderPath;
  if (!binary || !(await Bun.file(binary).exists())) {
    return jsonResponse(
      {
        code: "tile-encoder-missing",
        message: `no grid encoder at ${binary}; run tools/build-grid-encoder.sh`,
      },
      503,
    );
  }

  const child = Bun.spawn([binary, ...encoderArguments(windowID, options)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => {
    try {
      child.kill();
    } catch {
      // Already gone. Nothing to do and nothing to report.
    }
  };
  signal.addEventListener("abort", kill, { once: true });

  const source = frames(child.stdout as ReadableStream<Uint8Array>);
  let codec: string | null = null;
  let initial: Uint8Array | null = null;

  // Wait only as far as the first init segment, so the codec string is known
  // before the headers go out. Anything after that streams.
  for (;;) {
    const next = await source.next();
    if (next.done) {
      kill();
      const why = await new Response(child.stderr as ReadableStream).text();
      return jsonResponse(
        { code: "tile-encoder-failed", message: why.trim() || "encoder exited before producing video" },
        502,
      );
    }
    const frame = next.value;
    if (frame.kind === KIND_META) {
      const meta = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
      if (meta.type === "error") {
        kill();
        return jsonResponse({ code: "tile-encoder-failed", message: String(meta.message) }, 502);
      }
      if (meta.type === "codec" && typeof meta.codec === "string") codec = meta.codec;
    } else if (frame.kind === KIND_INIT) {
      initial = frame.payload;
      break;
    }
  }
  if (!codec || !initial) {
    kill();
    return jsonResponse({ code: "tile-encoder-failed", message: "no codec or init segment" }, 502);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(initial!);
    },
    async pull(controller) {
      // One frame per pull. The consumer's appetite is the encoder's rate.
      for (;;) {
        const next = await source.next();
        if (next.done) {
          controller.close();
          kill();
          return;
        }
        if (next.value.kind === KIND_MEDIA || next.value.kind === KIND_INIT) {
          controller.enqueue(next.value.payload);
          return;
        }
      }
    },
    cancel() {
      kill();
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
    return tile(match[1]!, options, request.signal).catch((error: unknown) =>
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
