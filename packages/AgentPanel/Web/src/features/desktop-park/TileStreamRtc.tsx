"use client";

import { useEffect, useRef, useState } from "react";
import type { TileState } from "./TileStream";

/**
 * One window, live, as a `<video>` fed by WebRTC. The transport-only variant.
 *
 * Where the MSE tile hand-feeds bytes and had to grow a live-edge chase,
 * buffer pruning, and reconnect policy, this one delegates all of it: the
 * sidecar's werift stack ships our VideoToolbox H.264 as SRTP, and the
 * webview's built-in WebRTC receiver owns jitter, late-frame dropping,
 * retransmit requests, and hardware decode straight into the compositor.
 * The component's whole job is one offer/answer POST and `srcObject`.
 *
 * A reconnect loop still exists, but only for peer death (a sidecar reload, a
 * network change ICE cannot restart across); packet-level trouble never
 * reaches this file.
 */
const RECONNECT_FIRST_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;
const HEALTHY_SESSION_MS = 15_000;
const RECONNECT_ATTEMPT_LIMIT = 6;
const CAPTURE_PIXEL_RATIO_CAP = 2;

export function TileStreamRtc({
  windowID,
  width,
  height,
  fps = 15,
  bitrate = 1_200_000,
  onState,
}: {
  windowID: number;
  /** The window's own size. Sets the tile's aspect; capture may be smaller. */
  width: number;
  height: number;
  fps?: number;
  bitrate?: number;
  onState?: (state: TileState) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TileState>({ kind: "connecting" });

  useEffect(() => {
    onState?.(state);
  }, [state, onState]);

  useEffect(() => {
    const element = video.current;
    if (!element) return undefined;
    if (typeof RTCPeerConnection === "undefined") {
      setState({ kind: "unsupported", message: "this webview has no RTCPeerConnection" });
      return undefined;
    }

    let cancelled = false;
    let activePeer: RTCPeerConnection | null = null;
    let wake: (() => void) | null = null;

    const captureSize = () => {
      const shown = frame.current?.clientWidth ?? width;
      const ratio = Math.min(window.devicePixelRatio || 1, CAPTURE_PIXEL_RATIO_CAP);
      const scale = Math.min(1, (shown * ratio) / width);
      return {
        width: Math.max(16, Math.round(width * scale)),
        height: Math.max(16, Math.round(height * scale)),
        bitrate: Math.max(300_000, Math.round(bitrate * scale * scale)),
      };
    };

    /** Resolves "ended" on peer death, "failed" when setup itself broke. */
    const session = (firstEver: boolean): Promise<"ended" | "cancelled" | string> =>
      new Promise((resolve) => {
        const started = performance.now();
        const peer = new RTCPeerConnection();
        activePeer = peer;
        let sawFrames = false;

        peer.addTransceiver("video", { direction: "recvonly" });
        peer.ontrack = (event) => {
          element.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void element.play().catch(() => {
            // Muted inline autoplay; a refusal is not worth the tile.
          });
        };
        element.addEventListener(
          "loadeddata",
          () => {
            if (cancelled) return;
            sawFrames = true;
            setState({
              kind: "playing",
              codec: "webrtc/h264",
              firstFrameMs: firstEver ? Math.round(performance.now() - started) : 0,
            });
          },
          { once: true },
        );
        peer.onconnectionstatechange = () => {
          const at = peer.connectionState;
          if (at === "failed" || at === "closed" || at === "disconnected") {
            peer.close();
            resolve(cancelled ? "cancelled" : sawFrames ? "ended" : "peer never connected");
          }
        };

        void (async () => {
          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            // Vanilla ICE: wait for gathering so the offer carries candidates
            // and signaling stays one round trip.
            if (peer.iceGatheringState !== "complete") {
              await new Promise<void>((done) => {
                const check = () => {
                  if (peer.iceGatheringState === "complete") {
                    peer.removeEventListener("icegatheringstatechange", check);
                    done();
                  }
                };
                peer.addEventListener("icegatheringstatechange", check);
              });
            }
            const capture = captureSize();
            const response = await fetch(`/api/park/tile/${windowID}/webrtc`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "offer",
                sdp: peer.localDescription!.sdp,
                width: capture.width,
                height: capture.height,
                fps,
                bitrate: capture.bitrate,
              }),
            });
            if (!response.ok) {
              const detail = await response.text().catch(() => "");
              peer.close();
              resolve(cancelled ? "cancelled" : detail.slice(0, 200) || `HTTP ${response.status}`);
              return;
            }
            const answer = (await response.json()) as { sdp: string };
            await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
          } catch (error) {
            peer.close();
            resolve(cancelled ? "cancelled" : (error as Error).message);
          }
        })();
      });

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

    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) wake?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    void (async () => {
      let attempt = 0;
      let firstEver = true;
      while (!cancelled) {
        const startedAt = performance.now();
        const end = await session(firstEver);
        firstEver = false;
        if (cancelled || end === "cancelled") return;
        if (performance.now() - startedAt > HEALTHY_SESSION_MS) attempt = 0;
        attempt += 1;
        if (end !== "ended" && attempt > RECONNECT_ATTEMPT_LIMIT) {
          setState({ kind: "error", message: end });
          return;
        }
        setState({ kind: "reconnecting", attempt });
        await delay(Math.min(RECONNECT_FIRST_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS));
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      wake?.();
      activePeer?.close();
      element.srcObject = null;
    };
  }, [windowID, width, height, fps, bitrate]);

  return (
    <div ref={frame} className="relative bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
      <video
        ref={video}
        muted
        autoPlay
        playsInline
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
