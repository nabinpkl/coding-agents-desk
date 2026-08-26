"use client";

import { useEffect, useRef, useState } from "react";

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
 */
export type TileState =
  | { kind: "connecting" }
  | { kind: "playing"; codec: string; firstFrameMs: number }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string };

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

export function TileStream({
  windowID,
  width,
  height,
  fps = 15,
  bitrate = 1_200_000,
  onState,
}: {
  windowID: number;
  width: number;
  height: number;
  fps?: number;
  bitrate?: number;
  onState?: (state: TileState) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<TileState>({ kind: "connecting" });

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

    const controller = new AbortController();
    let objectUrl: string | null = null;
    let cancelled = false;
    const started = performance.now();

    void (async () => {
      let response: Response;
      try {
        const query = new URLSearchParams({
          width: String(Math.round(width)),
          height: String(Math.round(height)),
          fps: String(fps),
          bitrate: String(bitrate),
        });
        response = await fetch(`/api/park/tile/${windowID}/stream?${query}`, {
          signal: controller.signal,
        });
      } catch (error) {
        if (!cancelled) setState({ kind: "error", message: (error as Error).message });
        return;
      }
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        if (!cancelled) {
          setState({ kind: "error", message: detail.slice(0, 200) || `HTTP ${response.status}` });
        }
        return;
      }
      const codec = response.headers.get("x-agentdesk-codec");
      if (!codec) {
        if (!cancelled) setState({ kind: "error", message: "stream did not declare its codec" });
        return;
      }

      const source = new Constructor();
      objectUrl = URL.createObjectURL(source as unknown as MediaSource);
      // A `<source>` child rather than `video.src`, which is the form WebKit's
      // own ManagedMediaSource example uses.
      const child = document.createElement("source");
      child.type = "video/mp4";
      child.src = objectUrl;
      element.appendChild(child);
      // A `<source>` appended to a live element is not picked up until the
      // element re-runs its resource selection. Without this the MediaSource
      // never opens and the tile sits at "connecting" forever, with bytes
      // arriving and nowhere to put them.
      element.load();

      const opened = await Promise.race([
        new Promise<boolean>((resolve) => {
          source.addEventListener("sourceopen", () => resolve(true), { once: true });
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (cancelled) return;
      if (!opened) {
        setState({ kind: "error", message: "the media source never opened" });
        return;
      }

      let buffer: SourceBuffer;
      try {
        source.duration = Infinity;
        buffer = source.addSourceBuffer(`video/mp4; codecs="${codec}"`);
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "unsupported", message: `${codec}: ${(error as Error).message}` });
        }
        return;
      }
      // Live: only the recent past is worth keeping, and an unbounded buffer on
      // a phone is what ManagedMediaSource exists to prevent.
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
          if (!painted) {
            painted = true;
            setState({ kind: "playing", codec, firstFrameMs: Math.round(performance.now() - started) });
            void element.play().catch(() => {
              // Autoplay refusal on a muted inline video is not expected, and is
              // not worth taking the tile down over.
            });
          }
        }
      } catch (error) {
        if (!cancelled) setState({ kind: "error", message: (error as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      element.replaceChildren();
      element.removeAttribute("src");
      element.load();
    };
  }, [windowID, width, height, fps, bitrate]);

  return (
    <div className="relative bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
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
      {state.kind !== "playing" ? (
        <p
          className={`absolute inset-0 grid place-items-center px-3 text-center font-mono text-[11px]
            ${state.kind === "connecting" ? "text-muted-foreground" : "text-destructive"}`}
        >
          {state.kind === "connecting" ? "connecting…" : state.message}
        </p>
      ) : null}
    </div>
  );
}
