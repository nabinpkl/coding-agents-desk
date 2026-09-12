"use client";

import { useEffect, useRef, useState } from "react";
import { desktopDisplayId } from "@agentdesk/agent-feed-wire";
import type {
  DesktopControlEvent,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import type { CapturePlan } from "./tileCapturePlan";
import {
  runTileSession,
  RETIRE_TIMEOUT_MS,
  VIDEO_DIAGNOSTIC_REVISION,
  type TileSessionRuntime,
} from "./tileStreamSession";
import { createVideoPresentationWatch } from "./tileVideoPresentation";
import { tileCaptureSize } from "./webrtcTileCapture";
import {
  parseWebrtcTileAnswer,
  postTileTelemetry,
  postWebrtcClose,
  type DesktopControlTransport,
} from "./webrtcTileWire";

// Re-exported: the surfaces that render a tile import this component, and these are what
// they hand it or read from it. The declarations live in the modules named.
export { CAPTURE_SCALE_MAX, CAPTURE_SCALE_MIN, tileCaptureSize } from "./webrtcTileCapture";
export {
  classifyReceiverProgress,
  receiverProgressDelta,
  RECEIVER_STATS_INTERVAL_MS,
  type ReceiverProgressSample,
} from "./webrtcReceiverStats";
export {
  parseWebrtcTileAnswer,
  postTileTelemetry,
  postWebrtcClose,
  type DesktopControlSendResult,
  type DesktopControlTransport,
  type TileTelemetryEvent,
} from "./webrtcTileWire";

/**
 * One window, live, as a `<video>` fed by WebRTC. The transport-only variant.
 *
 * Where the MSE tile hand-feeds bytes and had to grow a live-edge chase,
 * buffer pruning, and reconnect policy, this one delegates all of it: the
 * sidecar's werift stack ships our negotiated VideoToolbox codec as SRTP, and the
 * webview's built-in WebRTC receiver owns jitter, late-frame dropping,
 * retransmit requests, and hardware decode straight into the compositor.
 *
 * A reconnect loop still exists, but only for peer death (a sidecar reload, a
 * network change ICE cannot restart across); packet-level trouble never
 * reaches this file.
 *
 * The parts: `webrtcTileWire.ts` is the offer's answer and the two other HTTP calls,
 * `webrtcTileCapture.ts` sizes the capture, `tileVideoPresentation.ts` watches whether
 * frames reach the screen, `tileReceiverStats.ts` reads the receiver's own numbers, and
 * `tileControlChannel.ts` is the data channel input travels on.
 */
const RECONNECT_FIRST_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;
const HEALTHY_SESSION_MS = 15_000;
const RECONNECT_ATTEMPT_LIMIT = 6;

// Re-exported for the surfaces that time a stream against them.
export { FIRST_FRAME_TIMEOUT_MS, ICE_SETUP_TIMEOUT_MS } from "./tileStreamSession";

export function TileStreamRtc({
  windowID,
  displayId,
  width,
  height,
  fps = 15,
  bitrate = 1_200_000,
  captureScale = 1,
  capturePlan = null,
  control = true,
  fill = false,
  onState,
  onControlTransport,
  onControlEvent,
  onSourceMetadata,
  onFirstFrame,
  onDisplayUnavailable,
  httpTransport,
}: {
  /** A window id, or "display" for the whole active screen. */
  windowID: number | "display";
  displayId?: string;
  /** Known source size for catalogued windows. A display learns this from the answer. */
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  /** User-chosen multiplier on the automatic capture resolution. 1 is the display-fit default. */
  captureScale?: number;
  /**
   * A region of the display to capture, and the pixels to spend on it, or null for the whole
   * display at the automatic size. Decided by the viewer from what is on screen and what the
   * display holds; re-deriving a size here from the whole display would undo exactly that.
   */
  capturePlan?: CapturePlan | null;
  /**
   * Whether this stream carries the desktop control channel. One stream of a display owns input
   * and the cursor; a second stream of the same display, the sharp crop above the coarse whole,
   * must not, or the two would report the cursor twice and both would try to place it.
   */
  control?: boolean;
  /** Fill the parent instead of imposing the source's aspect ratio. */
  fill?: boolean;
  onState?: (state: DesktopStreamState) => void;
  onControlTransport?: (transport: DesktopControlTransport | null) => void;
  /** Cursor, focus, delivery, and ownership events on the ordered control channel. */
  onControlEvent?: (event: DesktopControlEvent) => void;
  /** Authoritative logical-point geometry from the native capture helper. */
  onSourceMetadata?: (metadata: WebrtcTileSourceMetadata) => void;
  onFirstFrame?: () => void;
  onDisplayUnavailable?: (replacementDisplayId: string) => void;
  /** Control-plane HTTP transport; omitted callers use same-origin fetch. */
  httpTransport?: Pick<AgentHttpTransport, "request">;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // The plan by value: a new one must renegotiate, an equal one must not, and display points are
  // whole, so rounding keeps sub-pixel gesture arithmetic from restarting the stream.
  const capturePlanKey = capturePlan
    ? `${Math.round(capturePlan.region.x)},${Math.round(capturePlan.region.y)},`
      + `${Math.round(capturePlan.region.width)},${Math.round(capturePlan.region.height)}`
      + `@${capturePlan.pixelWidth}x${capturePlan.pixelHeight}`
    : "";
  const [state, setState] = useState<DesktopStreamState>({ kind: "connecting" });
  const onControlTransportRef = useRef(onControlTransport);
  const onControlEventRef = useRef(onControlEvent);
  const onSourceMetadataRef = useRef(onSourceMetadata);
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  /**
   * The previous session's peer, kept alive until the next session has painted.
   *
   * A renegotiation -- a new capture region, a resolution change -- replaces the session, and the
   * old one used to be closed first, which blanked the video for as long as the new one took to
   * deliver a frame. The DeskZoom viewer keeps the old stream painting until the new one has
   * produced a frame and only then stops it; this is that. The timer is the safety net for a
   * successor that never paints, or for there being no successor at all.
   */
  const retiring = useRef<{ peer: RTCPeerConnection; attempt: string; timer: number } | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const onDisplayUnavailableRef = useRef(onDisplayUnavailable);
  onDisplayUnavailableRef.current = onDisplayUnavailable;

  useEffect(() => {
    onControlTransportRef.current = onControlTransport;
  }, [onControlTransport]);

  useEffect(() => {
    onControlEventRef.current = onControlEvent;
  }, [onControlEvent]);

  useEffect(() => {
    onSourceMetadataRef.current = onSourceMetadata;
  }, [onSourceMetadata]);

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

    const live: TileSessionRuntime = {
      cancelled: false,
      // Resolve the initial main alias once; reconnect must retain the same physical screen.
      resolvedDisplayId: displayId,
      activePeer: null,
      activeAttempt: null,
      cancelActiveSession: null,
      wake: null,
      activeControlTransport: null,
    };
    const closePeer = (peer: RTCPeerConnection, attempt: string) => {
      peer.close();
      postWebrtcClose(attempt, httpTransport);
    };
    const retirePrevious = () => {
      const previous = retiring.current;
      if (!previous) return;
      retiring.current = null;
      window.clearTimeout(previous.timer);
      closePeer(previous.peer, previous.attempt);
    };
    const retire = (peer: RTCPeerConnection, attempt: string) => {
      // One retiree at a time: a second handover before the first painted closes the older one.
      retirePrevious();
      retiring.current = {
        peer,
        attempt,
        timer: window.setTimeout(() => {
          if (retiring.current?.peer === peer) retiring.current = null;
          closePeer(peer, attempt);
        }, RETIRE_TIMEOUT_MS),
      };
    };
    const presentation = createVideoPresentationWatch(
      element,
      windowID,
      httpTransport,
      () => onFirstFrameRef.current?.(),
    );

    const publishControlTransport = (transport: DesktopControlTransport | null) => {
      live.activeControlTransport = transport;
      onControlTransportRef.current?.(transport);
    };

    const captureSize = () => {
      // Sized by the viewport, not by this stream's own box: under crop zoom the box is placed at
      // the zoom's scale, so at 11x on the 8K display it measured 16983 pixels wide, the sidecar
      // dropped the out-of-range width and encoded the whole display, and the phone timed out on
      // every 476 KB keyframe and reconnected every twelve seconds. A frame with no width yet (a
      // display handover mounts the new stream before its box is laid out) falls back to the
      // window for the same reason: an unsized offer is the whole display.
      const shown = frame.current?.closest<HTMLElement>("[data-desktop-viewport]")?.clientWidth
        || frame.current?.clientWidth
        || window.innerWidth;
      if (capturePlan) {
        // Bitrate follows the pixels actually encoded, at the rate the whole display would get,
        // rather than shrinking with the region: the region is the part being read. The plan
        // already fixed the pixels; the resolution knob has nothing to add here.
        const share = width && height
          ? Math.min(1, (capturePlan.pixelWidth * capturePlan.pixelHeight) / (width * height))
          : 1;
        return {
          width: capturePlan.pixelWidth,
          height: capturePlan.pixelHeight,
          bitrate: Math.max(300_000, Math.round(bitrate * Math.max(share, 0.25))),
        };
      }
      return tileCaptureSize(shown, width, height, window.devicePixelRatio, bitrate, captureScale);
    };
    const deps = {
      closePeer,
      retirePrevious,
      retire,
      publishControlTransport,
      captureSize,
      presentation,
      capturePlan,
      element,
      setState,
      setHasPicture,
      retiring,
      httpTransport,
      windowID,
      control,
      fps,
      displayId,
      onSourceMetadataRef,
      onControlEventRef,
      onDisplayUnavailableRef,
    };


    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        live.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }).finally(() => {
        live.wake = null;
      });

    const onVisible = () => {
      if (document.visibilityState === "visible" && !live.cancelled) live.wake?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    // React runs no cleanup when the document is torn down, so a reload used to leave the sidecar
    // believing this viewer was still watching until ICE consent expired. The reloaded page then
    // offered again, and any change of size made that a second capture of the same display beside
    // the abandoned one -- two ScreenCaptureKit captures of one target, which starve each other
    // into a black picture. Closing both peers here is what makes the reload look like a leave.
    const onPageHide = () => {
      const previous = retiring.current;
      if (previous) postWebrtcClose(previous.attempt, httpTransport);
      if (live.activeAttempt) postWebrtcClose(live.activeAttempt, httpTransport);
    };
    window.addEventListener("pagehide", onPageHide);

    void (async () => {
      let attempt = 0;
      let firstEver = true;
      while (!live.cancelled) {
        const startedAt = performance.now();
        const end = await runTileSession(live, deps, firstEver);
        firstEver = false;
        if (live.cancelled || end === "cancelled") return;
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
      live.cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      presentation.stop();
      live.wake?.();
      live.cancelActiveSession?.();
      // Not closed and not blanked: the picture stays until the next session has painted, or the
      // retiree's timer runs out. live.cancelActiveSession has already retired the peer.
      publishControlTransport(null);
    };
  }, [
    windowID,
    displayId,
    width,
    height,
    fps,
    bitrate,
    captureScale,
    capturePlanKey,
    httpTransport,
    VIDEO_DIAGNOSTIC_REVISION,
  ]);

  return (
    <div
      ref={frame}
      className={`relative bg-black ${fill ? "size-full" : ""}`}
      style={fill || width === undefined || height === undefined
        ? undefined
        : { aspectRatio: `${width} / ${height}` }}
    >
      <video
        ref={video}
        muted
        autoPlay
        playsInline
        className="size-full object-contain"
      />
      {(state.kind === "connecting" && !hasPicture) || state.kind === "unsupported" || state.kind === "error" ? (
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
