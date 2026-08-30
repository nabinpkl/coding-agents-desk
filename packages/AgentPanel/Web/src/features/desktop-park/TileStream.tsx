"use client";

import { useEffect, useRef, useState } from "react";
import type { DesktopStreamState } from "../desktop-viewer/DesktopStreamState";

/**
 * One window, live, as a `<video>`.
 *
 * The whole client side of the delivery path is the loop below: read bytes from
 * a never-ending response, hand them to a SourceBuffer. JavaScript never touches
 * a pixel. WebKit hardware-decodes and composites, which is the property that
 * makes many of these affordable at once and is why this is not WebCodecs, whose
 * `VideoFrame` would have to be drawn by the page.
 *
 * `ManagedMediaSource` first, plain `MediaSource` second. Measured on both
 * surfaces: macOS WKWebView has both, iPhone WKWebView has only the managed one,
 * and both accept fragmented HEVC. Managed is also the better citizen, since it
 * tells the page when to feed it rather than letting a page buffer without
 * bound on a phone.
 *
 * The codec string comes from the response header rather than a constant. The
 * encoder derives it from the stream it actually produced; a real capture came
 * back as level 90 where a hardcoded guess would have claimed 93, and MSE
 * rejects a SourceBuffer whose codec string does not describe the bytes.
 *
 * The stream ENDS sometimes, and that is normal: the sidecar cuts a reader
 * that stalled for ten seconds (a radio dip, the app backgrounded), a sidecar
 * reload drops every stream it was serving, a dev server restarts. A live tile
 * that freezes on its last frame when that happens is a broken tile, so each
 * connection is one session in a loop: when a session ends for any reason
 * other than the viewer closing the tile, the loop reconnects with backoff,
 * keeping the last frame on screen while it does.
 */
/** Fall this far behind the newest buffered frame and playback jumps forward. */
const MAX_LAG_SECONDS = 1.5;
/** Where the jump lands, back from the very edge so the seek target is buffered. */
const LIVE_EDGE_OFFSET_SECONDS = 0.3;
/** How much played history stays buffered before old ranges are evicted. */
const KEEP_BEHIND_SECONDS = 10;
/** Reconnect backoff: doubles from the first delay, capped, reset by a healthy run. */
const RECONNECT_FIRST_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;
/** A session that lived this long was healthy; the next drop starts backoff over. */
const HEALTHY_SESSION_MS = 15_000;
/** Give up reconnecting after this many consecutive immediate failures. */
const RECONNECT_ATTEMPT_LIMIT = 6;
/**
 * Capture no more pixels than the tile can show. The window itself may be
 * 1300 wide while the tile renders at 400: encoding the difference costs
 * encoder time, bandwidth, and phone-side decode for pixels nobody sees.
 */
const CAPTURE_PIXEL_RATIO_CAP = 2;

interface MediaSourceLike extends EventTarget {
  readyState: string;
  duration: number;
  addSourceBuffer(type: string): SourceBuffer;
  endOfStream(): void;
}

function mediaSourceConstructor(): (new () => MediaSourceLike) | null {
  const scope = globalThis as {
    ManagedMediaSource?: new () => MediaSourceLike;
    MediaSource?: new () => MediaSourceLike;
  };
  return scope.ManagedMediaSource ?? scope.MediaSource ?? null;
}

/** How one streaming session ended, which is what decides whether to retry. */
type SessionEnd =
  | { why: "ended" }
  | { why: "cancelled" }
  | { why: "failed"; message: string }
  | { why: "unsupported"; message: string };

export function TileStream({
  windowID,
  width,
  height,
  fps = 15,
  bitrate = 1_200_000,
  fill = false,
  onState,
}: {
  /** A window id, or "display" for the whole active screen. */
  windowID: number | "display";
  /** The source's own size. Sets the tile's aspect; capture may be smaller. */
  width: number;
  height: number;
  fps?: number;
  bitrate?: number;
  /** Fill the parent instead of imposing the source's aspect ratio. */
  fill?: boolean;
  onState?: (state: DesktopStreamState) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DesktopStreamState>({ kind: "connecting" });

  useEffect(() => {
    onState?.(state);
  }, [state, onState]);

  useEffect(() => {
    const element = video.current;
    if (!element) return undefined;
    const Constructor = mediaSourceConstructor();
    if (!Constructor) {
      setState({
        kind: "unsupported",
        message: "this webview has neither ManagedMediaSource nor MediaSource",
      });
      return undefined;
    }

    let cancelled = false;
    let activeController: AbortController | null = null;
    let wake: (() => void) | null = null;

    const captureSize = () => {
      // Measured once per session rather than observed live: a capture size is
      // an encoder restart, and chasing every layout change would thrash it.
      const shown = frame.current?.clientWidth ?? width;
      const ratio = Math.min(window.devicePixelRatio || 1, CAPTURE_PIXEL_RATIO_CAP);
      const scale = Math.min(1, (shown * ratio) / width);
      return {
        width: Math.max(16, Math.round(width * scale)),
        height: Math.max(16, Math.round(height * scale)),
        // Bits follow pixels: area shrinks with scale squared, and paying the
        // full-window bitrate for a phone-sized capture is where "laggy on the
        // phone" came from - the link was carrying pixels nobody saw.
        bitrate: Math.max(300_000, Math.round(bitrate * scale * scale)),
      };
    };

    // This is a live view, not a tape. The viewer always wants the newest
    // frame, so playback rides the live edge: snap there on start, re-snap
    // whenever it has fallen behind (a stall, a hidden page, a slow connect
    // all leave currentTime in the past while the buffer runs ahead).
    const liveEdge = () => {
      const ranges = element.buffered;
      return ranges.length ? ranges.end(ranges.length - 1) : 0;
    };
    const chaseLiveEdge = () => {
      const edge = liveEdge();
      if (edge - element.currentTime > MAX_LAG_SECONDS && !element.seeking) {
        element.currentTime = Math.max(0, edge - LIVE_EDGE_OFFSET_SECONDS);
      }
    };
    // The browser pauses muted video on its own (hidden page, power saving).
    // When the page comes back, resume at the live edge rather than staying
    // frozen on a frame from minutes ago.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      chaseLiveEdge();
      void element.play().catch(() => {});
      // A backgrounded webview also stalls the read loop until the server cut
      // it; waking the session loop lets a pending backoff end early.
      wake?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    const session = async (firstEver: boolean): Promise<SessionEnd> => {
      const controller = new AbortController();
      activeController = controller;
      const started = performance.now();

      let response: Response;
      try {
        const capture = captureSize();
        const query = new URLSearchParams({
          width: String(capture.width),
          height: String(capture.height),
          fps: String(fps),
          bitrate: String(capture.bitrate),
        });
        response = await fetch(`/api/park/tile/${windowID}/stream?${query}`, {
          signal: controller.signal,
        });
      } catch (error) {
        if (cancelled) return { why: "cancelled" };
        return { why: "failed", message: (error as Error).message };
      }
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        return { why: "failed", message: detail.slice(0, 200) || `HTTP ${response.status}` };
      }
      const codec = response.headers.get("x-agentdesk-codec");
      if (!codec) return { why: "failed", message: "stream did not declare its codec" };

      // The old source keeps showing its last frame through the whole backoff
      // wait; it is replaced only once the new stream is answering, so a
      // reconnect blanks the tile for the sub-second before the first new
      // frame rather than for the whole retry.
      const source = new Constructor();
      const objectUrl = URL.createObjectURL(source as unknown as MediaSource);
      try {
        // A `<source>` child rather than `video.src`, which is the form
        // WebKit's own ManagedMediaSource example uses.
        const child = document.createElement("source");
        child.type = "video/mp4";
        child.src = objectUrl;
        element.replaceChildren(child);
        // A `<source>` appended to a live element is not picked up until the
        // element re-runs its resource selection. Without this the MediaSource
        // never opens and the tile waits forever with bytes arriving and
        // nowhere to put them.
        element.load();

        const opened = await Promise.race([
          new Promise<boolean>((resolve) => {
            source.addEventListener("sourceopen", () => resolve(true), { once: true });
          }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (cancelled) return { why: "cancelled" };
        if (!opened) return { why: "failed", message: "the media source never opened" };

        let buffer: SourceBuffer;
        try {
          source.duration = Infinity;
          buffer = source.addSourceBuffer(`video/mp4; codecs="${codec}"`);
        } catch (error) {
          return { why: "unsupported", message: `${codec}: ${(error as Error).message}` };
        }
        try {
          buffer.mode = "sequence";
        } catch {
          // Some engines only allow this before the first append; not fatal.
        }

        const settle = () =>
          new Promise<void>((resolve) => {
            if (!buffer.updating) return resolve();
            buffer.addEventListener("updateend", () => resolve(), { once: true });
          });

        const reader = response.body.getReader();
        let painted = false;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || cancelled) break;
            if (!value) continue;
            await settle();
            if (cancelled) break;
            buffer.appendBuffer(value);
            await settle();
            chaseLiveEdge();
            // Only the recent past is worth its memory. Without this the
            // buffer grows for as long as the tile is open; measured at 117s
            // in two minutes before this existed.
            const ranges = element.buffered;
            if (ranges.length && element.currentTime - ranges.start(0) > KEEP_BEHIND_SECONDS) {
              buffer.remove(ranges.start(0), element.currentTime - KEEP_BEHIND_SECONDS / 2);
              await settle();
            }
            if (!painted) {
              painted = true;
              setState({
                kind: "playing",
                codec,
                firstFrameMs: firstEver ? Math.round(performance.now() - started) : 0,
              });
              void element.play().catch(() => {
                // Autoplay refusal on a muted inline video is not expected,
                // and is not worth taking the tile down over.
              });
            }
          }
        } catch (error) {
          if (cancelled) return { why: "cancelled" };
          return { why: "failed", message: (error as Error).message };
        }
        return cancelled ? { why: "cancelled" } : { why: "ended" };
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };

    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }).finally(() => {
        wake = null;
      });

    void (async () => {
      let attempt = 0;
      let firstEver = true;
      while (!cancelled) {
        const startedAt = performance.now();
        const end = await session(firstEver);
        firstEver = false;
        if (cancelled || end.why === "cancelled") return;
        if (end.why === "unsupported") {
          setState({ kind: "unsupported", message: end.message });
          return;
        }
        // A session that ran for a while was real; its drop is a blip, not a
        // strike against the retry budget.
        if (performance.now() - startedAt > HEALTHY_SESSION_MS) attempt = 0;
        attempt += 1;
        if (end.why === "failed" && attempt > RECONNECT_ATTEMPT_LIMIT) {
          setState({ kind: "error", message: end.message });
          return;
        }
        setState({ kind: "reconnecting", attempt });
        await delay(
          Math.min(RECONNECT_FIRST_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS),
        );
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      wake?.();
      activeController?.abort();
      element.replaceChildren();
      element.removeAttribute("src");
      element.load();
    };
  }, [windowID, width, height, fps, bitrate]);

  return (
    <div
      ref={frame}
      className={`relative bg-black ${fill ? "size-full" : ""}`}
      style={fill ? undefined : { aspectRatio: `${width} / ${height}` }}
    >
      <video
        ref={video}
        muted
        autoPlay
        playsInline
        // ManagedMediaSource wants remote playback off; harmless where ignored.
        // eslint-disable-next-line react/no-unknown-property
        disableRemotePlayback
        className="size-full object-contain"
      />
      {state.kind === "connecting" || state.kind === "unsupported" || state.kind === "error" ? (
        <p
          className={`absolute inset-0 grid place-items-center px-3 text-center font-mono text-[11px]
            ${state.kind === "connecting" ? "text-muted-foreground" : "text-destructive"}`}
        >
          {state.kind === "connecting" ? "connecting…" : state.message}
        </p>
      ) : null}
      {state.kind === "reconnecting" ? (
        <p className="absolute bottom-1 right-2 font-mono text-[10px] text-muted-foreground">
          reconnecting…
        </p>
      ) : null}
    </div>
  );
}
