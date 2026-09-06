"use client";

import { useEffect, useRef, useState } from "react";
import { desktopDisplayId } from "@agentdesk/agent-feed-wire";
import type {
  DesktopControlEvent,
  DesktopControlInput,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import type { CapturePlan } from "./tileCapturePlan";

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
 */
const RECONNECT_FIRST_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;
const HEALTHY_SESSION_MS = 15_000;
const RECONNECT_ATTEMPT_LIMIT = 6;
const ICE_DISCONNECTED_GRACE_MS = 8_000;
// One sample per second is the diagnostic clock for correlating host RTP writes,
// selected-candidate delivery, and receiver progress. Presentation-gap samples may
// occur between ticks; the sidecar coalesces them onto the same one-second timeline.
export const RECEIVER_STATS_INTERVAL_MS = 1_000;
const VIDEO_PRESENTATION_INTERVAL_MS = 5_000;
const PRESENTATION_WATCHDOG_INTERVAL_MS = 250;
const PRESENTATION_GAP_THRESHOLD_MS = 750;
const PRESENTATION_GAP_REPORT_INTERVAL_MS = 1_000;
// Fast Refresh preserves mounted effects when their dependency values do not
// change. Bump this only when live diagnostic ownership itself changes so the
// running WebView adopts that instrumentation without a reload or relaunch.
const VIDEO_DIAGNOSTIC_REVISION = 13;
// WebKit can leave a peer in `connecting` forever when no candidate pair is
// viable. A setup attempt either connects inside this window or yields to the
// existing reconnect loop with an explicit diagnostic phase.
export const ICE_SETUP_TIMEOUT_MS = 12_000;
export const FIRST_FRAME_TIMEOUT_MS = 12_000;
// 3, not 2: the phone renders at 3x, and capturing below the display density
// guarantees an upscale that reads as blurry text no matter what the codec
// does. Bits follow pixels via the scale-squared bitrate, so the cost lands
// only where the density exists.
const CAPTURE_PIXEL_RATIO_CAP = 3;
/** How long a replaced session's picture is kept when nothing comes along to replace it. */
const RETIRE_TIMEOUT_MS = 4_000;
const MAX_SOURCE_EXTENT = 100_000;
const CONTROL_CHANNEL_LABEL = "agentdesk-control-v2";
const CONTROL_BUFFER_LIMIT = 64 * 1024;

export interface DesktopControlTransport {
  send(input: DesktopControlInput): DesktopControlSendResult;
  /** Terminal controls cannot sit behind an unbounded data-channel backlog. */
  abort?(): void;
}

export type DesktopControlSendResult = "sent" | "channel-closed" | "backpressured";

export interface TileTelemetryEvent {
  attempt: string;
  phase: string;
  detail?: string;
  elapsedMs?: number;
}

function validSourceMetadata(value: unknown): value is WebrtcTileSourceMetadata {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  const cursor = source.cursor;
  return typeof source.width === "number"
    && Number.isFinite(source.width)
    && source.width > 0
    && source.width <= MAX_SOURCE_EXTENT
    && typeof source.height === "number"
    && Number.isFinite(source.height)
    && source.height > 0
    && source.height <= MAX_SOURCE_EXTENT
    && (source.displayId === undefined || desktopDisplayId(source.displayId))
    && (source.desktopNavigationVersion === undefined
      || (Number.isSafeInteger(source.desktopNavigationVersion) && Number(source.desktopNavigationVersion) > 0))
    && (source.desktopControlVersion === undefined
      || (typeof source.desktopControlVersion === "number"
        && Number.isSafeInteger(source.desktopControlVersion)
        && source.desktopControlVersion > 0))
    && typeof cursor === "object"
    && cursor !== null
    && typeof (cursor as { x?: unknown }).x === "number"
    && Number.isFinite((cursor as { x: number }).x)
    && (cursor as { x: number }).x >= 0
    && (cursor as { x: number }).x < source.width
    && typeof (cursor as { y?: unknown }).y === "number"
    && Number.isFinite((cursor as { y: number }).y)
    && (cursor as { y: number }).y >= 0
    && (cursor as { y: number }).y < source.height;
}

export function parseWebrtcTileAnswer(body: string): WebrtcTileAnswer {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("WebRTC answer was invalid");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("WebRTC answer was invalid");
  }
  const answer = value as Record<string, unknown>;
  if (
    answer.type !== "answer"
    || typeof answer.sdp !== "string"
    || answer.sdp.length === 0
    || (answer.codec !== "h264" && answer.codec !== "h265")
    || !validSourceMetadata(answer.source)
  ) throw new Error("WebRTC answer was invalid");
  const source = answer.source as unknown as Record<string, unknown>;
  return {
    type: "answer",
    sdp: answer.sdp,
    codec: answer.codec,
    source: {
      ...source,
      desktopControlVersion: typeof source.desktopControlVersion === "number"
        ? source.desktopControlVersion
        : 0,
    },
  } as WebrtcTileAnswer;
}

/** The slider's range: a multiplier on the auto-chosen capture scale, capped at source-native. */
export const CAPTURE_SCALE_MIN = 0.5;
export const CAPTURE_SCALE_MAX = 3;

export function tileCaptureSize(
  shownWidth: number,
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  devicePixelRatio: number,
  bitrate: number,
  captureScale = 1,
): { width?: number; height?: number; bitrate: number } {
  const ratio = Math.min(devicePixelRatio || 1, CAPTURE_PIXEL_RATIO_CAP);
  // The user's knob multiplies the automatic scale. At 1 it is exactly the display-fit default;
  // above 1 it captures sharper than the picture is shown, up to source-native, so zooming in stays
  // crisp at the cost of bitrate; below 1 it trades sharpness for a thinner stream.
  const quality = Math.min(Math.max(captureScale, CAPTURE_SCALE_MIN), CAPTURE_SCALE_MAX);
  if (
    typeof sourceWidth !== "number"
    || !Number.isFinite(sourceWidth)
    || sourceWidth <= 0
    || typeof sourceHeight !== "number"
    || !Number.isFinite(sourceHeight)
    || sourceHeight <= 0
  ) {
    return {
      width: shownWidth > 0 ? Math.max(16, Math.round(shownWidth * ratio * quality)) : undefined,
      bitrate: Math.max(300_000, Math.round(bitrate * quality * quality)),
    };
  }
  const visibleWidth = shownWidth > 0 ? shownWidth : sourceWidth;
  const scale = Math.min(1, (visibleWidth * ratio * quality) / sourceWidth);
  return {
    width: Math.max(16, Math.round(sourceWidth * scale)),
    height: Math.max(16, Math.round(sourceHeight * scale)),
    bitrate: Math.max(300_000, Math.round(bitrate * scale * scale)),
  };
}

/**
 * Sends WebView-authored evidence through the same authenticated control path
 * as the rest of the panel. The page never receives the sidecar token.
 */
/**
 * Tells the sidecar a peer is gone. Closing an RTCPeerConnection sends nothing the sidecar can
 * see, so without this it keeps the capture running until ICE consent expires thirty seconds
 * later; with two captures on one display that is a second whole-display capture nobody watches.
 *
 * `keepalive` is what makes this work on the way out of a page. A reload -- an HMR one included --
 * destroys the document without running React cleanup, and cancels every request in flight, so an
 * ordinary fetch fired from `pagehide` would be dropped and the abandoned capture would live on
 * for the consent timeout while the reloaded page asked for one of its own.
 */
export function postWebrtcClose(attempt: string, httpTransport?: Pick<AgentHttpTransport, "request">) {
  const body = { attempt };
  const request = httpTransport
    ? httpTransport.request("POST", "/api/park/webrtc/sessions/close", { body })
    : fetch("/api/park/webrtc/sessions/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      });
  void request.catch(() => {
    // Best effort; the sidecar's consent timeout is the fallback.
  });
}

export function postTileTelemetry(
  windowID: number | "display",
  event: TileTelemetryEvent,
  httpTransport?: Pick<AgentHttpTransport, "request">,
) {
  const request = httpTransport
    ? httpTransport.request(
        "POST",
        `/api/park/tile/${windowID}/webrtc/telemetry`,
        { body: event },
      )
    : fetch(`/api/park/tile/${windowID}/webrtc/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
  void request.catch(() => {
    // Evidence is best effort. The gesture or connection state remains
    // authoritative when its diagnostic request cannot reach the Mac.
  });
}

type ReceiverVideoStats = RTCInboundRtpStreamStats & {
  bytesReceived?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  framesPerSecond?: number;
  keyFramesDecoded?: number;
  mediaType?: string;
  packetsRepaired?: number;
  powerEfficientDecoder?: boolean;
};

type CandidateStats = RTCStats & {
  candidateType?: string;
  networkType?: string;
  protocol?: string;
  relayProtocol?: string;
  tcpType?: string;
};

type CandidatePairStats = RTCIceCandidatePairStats & {
  bytesReceived?: number;
  bytesSent?: number;
  nominated?: boolean;
  state?: string;
};

export interface ReceiverProgressSample {
  atMs: number;
  bytesReceived: number;
  packetsReceived: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  presentedSamples: number;
  connectionState: RTCPeerConnectionState;
  visibilityState: DocumentVisibilityState;
}

export function receiverProgressDelta(
  previous: ReceiverProgressSample | null,
  current: ReceiverProgressSample,
) {
  if (!previous) return null;
  return {
    intervalMs: Math.max(0, Math.round(current.atMs - previous.atMs)),
    bytes: current.bytesReceived - previous.bytesReceived,
    packets: current.packetsReceived - previous.packetsReceived,
    received: current.framesReceived - previous.framesReceived,
    decoded: current.framesDecoded - previous.framesDecoded,
    dropped: current.framesDropped - previous.framesDropped,
    presented: current.presentedSamples - previous.presentedSamples,
  };
}

/**
 * Classifies the first pipeline boundary that stopped moving. This is deliberately
 * counter-based: a static desktop still produces access units, so decoded frames without
 * compositor callbacks is our/WebKit presentation trouble, while no inbound bytes after
 * the Mac reports sends is genuine path silence.
 */
export function classifyReceiverProgress(
  previous: ReceiverProgressSample | null,
  current: ReceiverProgressSample,
): string {
  if (current.visibilityState !== "visible") return "page-hidden";
  if (
    current.connectionState === "disconnected"
    || current.connectionState === "failed"
    || current.connectionState === "closed"
  ) return "transport-disconnected";
  const delta = receiverProgressDelta(previous, current);
  if (!delta) return "baseline";
  if (delta.bytes <= 0 && delta.packets <= 0) return "source-or-network-silent";
  if (delta.received <= 0) return "rtp-frame-assembly-stalled";
  if (delta.decoded <= 0) return "decoder-stalled";
  if (delta.presented <= 0) return "presentation-stalled";
  return "progressing";
}

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

    let cancelled = false;
    // Resolve the initial main alias once; reconnect must retain the same physical screen.
    let resolvedDisplayId = displayId;
    let activePeer: RTCPeerConnection | null = null;
    let activeAttempt: string | null = null;
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
    let cancelActiveSession: (() => void) | null = null;
    let wake: (() => void) | null = null;
    let activeControlTransport: DesktopControlTransport | null = null;
    type VideoPresentationOwner = {
      attempt: string;
      report: (phase: string, detail?: string) => void;
      sampleHealth: (reason: string, gapMs?: number) => void;
      frameRequest: number | null;
      presentedSamples: number;
      lastPresentedAt: number | null;
      mediaTime: number | null;
      gapStartedAt: number | null;
      lastGapReportAt: number | null;
      lastGapClassification: string | null;
    };
    let videoOwner: VideoPresentationOwner | null = null;
    const pixelCanvas = document.createElement("canvas");
    pixelCanvas.width = 4;
    pixelCanvas.height = 4;
    const pixelContext = pixelCanvas.getContext("2d", { willReadFrequently: true });

    const decodedPixelSample = (): Record<string, unknown> => {
      if (!pixelContext || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return { pixelSample: "unavailable" };
      }
      try {
        pixelContext.drawImage(element, 0, 0, pixelCanvas.width, pixelCanvas.height);
        const pixels = pixelContext.getImageData(
          0,
          0,
          pixelCanvas.width,
          pixelCanvas.height,
        ).data;
        let total = 0;
        let minimum = 255;
        let maximum = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const luma = Math.round(
            (pixels[index] * 54 + pixels[index + 1] * 183 + pixels[index + 2] * 19) / 256,
          );
          total += luma;
          minimum = Math.min(minimum, luma);
          maximum = Math.max(maximum, luma);
        }
        return {
          pixelMean: Math.round(total / (pixels.length / 4)),
          pixelRange: `${minimum}-${maximum}`,
        };
      } catch (error) {
        return {
          pixelSampleError: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const videoPresentationDetail = (event: string, extra: Record<string, unknown> = {}) => {
      const owner = videoOwner;
      if (!owner) return;
      const stream = element.srcObject instanceof MediaStream ? element.srcObject : null;
      const track = stream?.getVideoTracks()[0];
      const quality = typeof element.getVideoPlaybackQuality === "function"
        ? element.getVideoPlaybackQuality()
        : null;
      const style = getComputedStyle(element);
      const elementRect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.max(0, Math.min(window.innerWidth - 1, elementRect.left + elementRect.width / 2)),
        Math.max(0, Math.min(window.innerHeight - 1, elementRect.top + elementRect.height / 2)),
      ) as HTMLElement | null;
      const contentStyle = element.parentElement?.parentElement
        ? getComputedStyle(element.parentElement.parentElement)
        : null;
      const ancestorSizes: string[] = [];
      let ancestor: HTMLElement | null = element;
      for (let depth = 0; ancestor && depth < 6; depth += 1) {
        ancestorSizes.push(`${ancestor.tagName}:${ancestor.clientWidth}x${ancestor.clientHeight}`);
        ancestor = ancestor.parentElement;
      }
      owner.report("video-presentation", JSON.stringify({
        event,
        owner: owner.attempt.slice(0, 8),
        document: document.visibilityState,
        currentTime: Math.round(element.currentTime * 1_000) / 1_000,
        presentedSamples: owner.presentedSamples,
        lastPresentedAgeMs: owner.lastPresentedAt === null
          ? -1
          : Math.round(performance.now() - owner.lastPresentedAt),
        mediaTime: owner.mediaTime,
        presentation: "video",
        contentTransform: contentStyle?.transform ?? "none",
        contentWillChange: contentStyle?.willChange ?? "none",
        centerHit: hit
          ? `${hit.tagName}.${typeof hit.className === "string" ? hit.className.slice(0, 80) : ""}`
          : "none",
        ...decodedPixelSample(),
        readyState: element.readyState,
        networkState: element.networkState,
        paused: element.paused,
        ended: element.ended,
        trackState: track?.readyState ?? "none",
        trackMuted: track?.muted,
        trackEnabled: track?.enabled,
        video: `${element.videoWidth}x${element.videoHeight}`,
        client: `${element.clientWidth}x${element.clientHeight}`,
        ancestors: ancestorSizes.join("|"),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        outer: `${window.outerWidth}x${window.outerHeight}@${window.screenX},${window.screenY}`,
        screen: `${window.screen.width}x${window.screen.height}`,
        available: `${window.screen.availWidth}x${window.screen.availHeight}`,
        visualViewport: window.visualViewport
          ? `${Math.round(window.visualViewport.width)}x${Math.round(window.visualViewport.height)}`
          : "none",
        cssSize: `${style.width}x${style.height}`,
        opacity: style.opacity,
        visibility: style.visibility,
        display: style.display,
        ...(quality && (quality.totalVideoFrames > 0 || quality.droppedVideoFrames > 0)
          ? {
              totalFrames: quality.totalVideoFrames,
              droppedFrames: quality.droppedVideoFrames,
            }
          : {}),
        ...extra,
      }));
    };

    const armVideoPresentationSample = (owner: VideoPresentationOwner): void => {
      if (videoOwner !== owner || owner.frameRequest !== null) return;
      if (typeof element.requestVideoFrameCallback !== "function") return;
      owner.frameRequest = element.requestVideoFrameCallback((_now, metadata) => {
        if (videoOwner !== owner) return;
        const recoveredGapMs = owner.gapStartedAt === null
          ? null
          : Math.round(performance.now() - owner.gapStartedAt);
        owner.frameRequest = null;
        owner.presentedSamples += 1;
        if (owner.presentedSamples === 1) onFirstFrameRef.current?.();
        owner.lastPresentedAt = performance.now();
        owner.mediaTime = metadata.mediaTime;
        if (recoveredGapMs !== null) {
          owner.gapStartedAt = null;
          owner.lastGapReportAt = null;
          owner.sampleHealth("recovered", recoveredGapMs);
        }
        armVideoPresentationSample(owner);
      });
    };

    const videoEvents = [
      "playing",
      "waiting",
      "stalled",
      "suspend",
      "pause",
      "ended",
      "emptied",
      "error",
      "resize",
    ] as const;
    const onVideoEvent = (event: Event) => videoPresentationDetail(event.type);
    for (const event of videoEvents) element.addEventListener(event, onVideoEvent);
    const presentationTimer = window.setInterval(() => {
      videoPresentationDetail("sample");
      if (videoOwner) armVideoPresentationSample(videoOwner);
    }, VIDEO_PRESENTATION_INTERVAL_MS);
    const presentationWatchdogTimer = window.setInterval(() => {
      const owner = videoOwner;
      if (
        !owner
        || owner.lastPresentedAt === null
        || document.visibilityState !== "visible"
        || element.paused
        || element.ended
      ) return;
      const stream = element.srcObject instanceof MediaStream ? element.srcObject : null;
      const track = stream?.getVideoTracks()[0];
      if (!track || track.readyState !== "live" || track.muted) return;
      const now = performance.now();
      const gapMs = now - owner.lastPresentedAt;
      if (gapMs < PRESENTATION_GAP_THRESHOLD_MS) return;
      if (owner.gapStartedAt === null) owner.gapStartedAt = owner.lastPresentedAt;
      if (
        owner.lastGapReportAt !== null
        && now - owner.lastGapReportAt < PRESENTATION_GAP_REPORT_INTERVAL_MS
      ) return;
      const reason = owner.lastGapReportAt === null ? "detected" : "progress";
      owner.lastGapReportAt = now;
      owner.sampleHealth(reason, Math.round(gapMs));
    }, PRESENTATION_WATCHDOG_INTERVAL_MS);

    const publishControlTransport = (transport: DesktopControlTransport | null) => {
      activeControlTransport = transport;
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

    /** Resolves "ended" on peer death, "failed" when setup itself broke. */
    const session = (firstEver: boolean): Promise<"ended" | "cancelled" | string> =>
      new Promise((resolve) => {
        const started = performance.now();
        const peer = new RTCPeerConnection();
        const offerAbort = new AbortController();
        activePeer = peer;
        let sawFrames = false;
        let finished = false;
        let negotiatedCodec: WebrtcTileAnswer["codec"] | null = null;
        let controlCompatible = false;
        const attempt = crypto.randomUUID();
        // Named here so a document teardown can report this peer gone; see `onPageHide`.
        activeAttempt = attempt;
        const report = (phase: string, detail?: string) => {
          postTileTelemetry(windowID, {
            attempt,
            phase,
            detail,
            elapsedMs: Math.round(performance.now() - started),
          }, httpTransport);
        };
        // A stream without control still negotiates the channel, so the sidecar's protocol check
        // is unchanged, but never opens it for input and never publishes a transport.
        const inputChannel = peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true });
        inputChannel.onmessage = (message) => {
          if (!control) return;
          if (typeof message.data !== "string") return;
          try {
            const event = JSON.parse(message.data) as Partial<DesktopControlEvent>;
            if (typeof event.type === "string") {
              onControlEventRef.current?.(event as DesktopControlEvent);
            }
          } catch {
            report("control-channel-state", "invalid control event");
          }
        };
        const controlTransport: DesktopControlTransport = {
          abort() { finish("control channel backpressure"); },
          send(input) {
            if (inputChannel.readyState !== "open") return "channel-closed";
            if (inputChannel.bufferedAmount > CONTROL_BUFFER_LIMIT) return "backpressured";
            inputChannel.send(JSON.stringify(input));
            return "sent";
          },
        };
        const clearControlTransport = () => {
          if (activeControlTransport === controlTransport) publishControlTransport(null);
        };
        inputChannel.onopen = () => {
          if (!control) {
            inputChannel.close();
            return;
          }
          if (!controlCompatible) {
            report("control-channel-state", "protocol-mismatch client=2");
            inputChannel.close();
            return;
          }
          report("control-channel-state", "open");
          controlTransport.send({ type: "configure", initialFocusDelayMs: 80, settleFocusDelayMs: 160 });
          publishControlTransport(controlTransport);
        };
        inputChannel.onclose = () => {
          report("control-channel-state", "closed");
          clearControlTransport();
        };
        inputChannel.onerror = () => {
          report("control-channel-state", "error");
          clearControlTransport();
        };
        let statsInFlight = false;
        let pendingStatsReason: { reason: string; gapMs?: number } | null = null;
        let lastReceiverSample: ReceiverProgressSample | null = null;
        let lastCandidatePairID: string | null = null;
        let receiverStatsSample = 0;
        const rounded = (value: unknown, scale = 1) =>
          typeof value === "number" && Number.isFinite(value)
            ? Math.round(value * scale)
            : undefined;
        const averageMilliseconds = (total: unknown, count: unknown) =>
          typeof total === "number"
          && Number.isFinite(total)
          && typeof count === "number"
          && Number.isFinite(count)
          && count > 0
            ? Math.round((total * 1_000) / count)
            : undefined;
        const candidateDescription = (candidate: CandidateStats | undefined) => {
          if (!candidate) return "unknown";
          return [
            candidate.candidateType ?? "unknown",
            candidate.protocol ?? "unknown",
            candidate.networkType,
            candidate.relayProtocol,
            candidate.tcpType,
          ].filter(Boolean).join("/");
        };
        const sampleReceiverStats = async (reason = "interval", gapMs?: number) => {
          if (finished) return;
          if (statsInFlight) {
            const isGapReason = reason === "detected"
              || reason === "progress"
              || reason === "recovered";
            const pendingIsGap = pendingStatsReason?.reason === "detected"
              || pendingStatsReason?.reason === "progress"
              || pendingStatsReason?.reason === "recovered";
            if (!pendingIsGap || isGapReason) pendingStatsReason = { reason, gapMs };
            return;
          }
          statsInFlight = true;
          try {
            const stats = await peer.getStats();
            if (finished) return;
            let inbound: ReceiverVideoStats | undefined;
            let transport: RTCTransportStats | undefined;
            stats.forEach((entry) => {
              if (
                entry.type === "inbound-rtp"
                && (entry.kind === "video" || entry.mediaType === "video")
              ) {
                inbound = entry as ReceiverVideoStats;
              } else if (entry.type === "transport") {
                transport = entry as RTCTransportStats;
              }
            });
            if (!inbound) {
              report("receiver-stats-error", "no inbound video stats");
              return;
            }
            const candidatePair = transport?.selectedCandidatePairId
              ? stats.get(transport.selectedCandidatePairId) as CandidatePairStats | undefined
              : undefined;
            let selectedPair = candidatePair;
            if (!selectedPair) {
              stats.forEach((entry) => {
                const pair = entry as CandidatePairStats;
                if (
                  !selectedPair
                  && pair.type === "candidate-pair"
                  && pair.state === "succeeded"
                  && pair.nominated
                ) selectedPair = pair;
              });
            }
            const localCandidate = selectedPair?.localCandidateId
              ? stats.get(selectedPair.localCandidateId) as CandidateStats | undefined
              : undefined;
            const remoteCandidate = selectedPair?.remoteCandidateId
              ? stats.get(selectedPair.remoteCandidateId) as CandidateStats | undefined
              : undefined;
            const now = performance.now();
            const owner = videoOwner?.attempt === attempt ? videoOwner : null;
            const current: ReceiverProgressSample = {
              atMs: now,
              bytesReceived: rounded(inbound.bytesReceived) ?? 0,
              packetsReceived: rounded(inbound.packetsReceived) ?? 0,
              framesReceived: rounded(inbound.framesReceived) ?? 0,
              framesDecoded: rounded(inbound.framesDecoded) ?? 0,
              framesDropped: rounded(inbound.framesDropped) ?? 0,
              presentedSamples: owner?.presentedSamples ?? 0,
              connectionState: peer.connectionState,
              visibilityState: document.visibilityState,
            };
            const delta = receiverProgressDelta(lastReceiverSample, current);
            const progress = classifyReceiverProgress(lastReceiverSample, current);
            receiverStatsSample += 1;
            const pairID = selectedPair?.id ?? null;
            const pairChanged = lastCandidatePairID !== null && pairID !== lastCandidatePairID;
            const presentationGapEvent = reason === "detected"
              || reason === "progress"
              || reason === "recovered";
            lastReceiverSample = current;
            lastCandidatePairID = pairID;
            if (owner && presentationGapEvent) owner.lastGapClassification = progress;
            report(presentationGapEvent ? "presentation-gap" : "receiver-stats", JSON.stringify({
              event: reason,
              sample: receiverStatsSample,
              gapMs,
              progress,
              delta,
              peer: {
                connection: peer.connectionState,
                ice: peer.iceConnectionState,
                signaling: peer.signalingState,
                gathering: peer.iceGatheringState,
              },
              presentation: {
                document: document.visibilityState,
                presented: current.presentedSamples,
                ageMs: owner?.lastPresentedAt === null || owner?.lastPresentedAt === undefined
                  ? -1
                  : Math.round(now - owner.lastPresentedAt),
                readyState: element.readyState,
                paused: element.paused,
                ended: element.ended,
              },
              inbound: {
                bytes: current.bytesReceived,
                packets: current.packetsReceived,
                lost: rounded(inbound.packetsLost),
                repaired: rounded(inbound.packetsRepaired),
                discarded: rounded(inbound.packetsDiscarded),
                jitterMs: rounded(inbound.jitter, 1_000),
                received: current.framesReceived,
                decoded: current.framesDecoded,
                dropped: current.framesDropped,
                fps: rounded(inbound.framesPerSecond),
                keyframes: rounded(inbound.keyFramesDecoded),
                freezes: rounded(inbound.freezeCount),
                freezeMs: rounded(inbound.totalFreezesDuration, 1_000),
                jitterBufferMs: averageMilliseconds(
                  inbound.jitterBufferDelay,
                  inbound.jitterBufferEmittedCount,
                ),
                jitterTargetMs: averageMilliseconds(
                  inbound.jitterBufferTargetDelay,
                  inbound.jitterBufferEmittedCount,
                ),
                decodeMs: averageMilliseconds(inbound.totalDecodeTime, inbound.framesDecoded),
                nack: rounded(inbound.nackCount),
                pli: rounded(inbound.pliCount),
                decoder: inbound.decoderImplementation,
                powerEfficient: inbound.powerEfficientDecoder,
              },
              path: {
                pair: pairID?.slice(0, 16),
                changed: pairChanged,
                state: selectedPair?.state,
                nominated: selectedPair?.nominated,
                local: candidateDescription(localCandidate),
                remote: candidateDescription(remoteCandidate),
                bytesReceived: rounded(selectedPair?.bytesReceived),
                bytesSent: rounded(selectedPair?.bytesSent),
                rttMs: rounded(selectedPair?.currentRoundTripTime, 1_000),
                incomingKbps: rounded(selectedPair?.availableIncomingBitrate, 1 / 1_000),
              },
            }));
          } catch (error) {
            if (!finished) {
              report(
                "receiver-stats-error",
                error instanceof Error ? error.message : String(error),
              );
            }
          } finally {
            statsInFlight = false;
            const pending = pendingStatsReason;
            pendingStatsReason = null;
            if (pending && !finished) {
              void sampleReceiverStats(pending.reason, pending.gapMs);
            }
          }
        };
        let setupTimer = 0;
        let statsTimer = 0;
        let disconnectTimer = 0;
        let removeLoadedDataListener = () => {};
        const clearSetupTimer = () => {
          if (setupTimer === 0) return;
          window.clearTimeout(setupTimer);
          setupTimer = 0;
        };
        let cancelSession: (() => void) | null = null;
        const finish = (outcome: "ended" | "cancelled" | string) => {
          if (finished) return;
          if (videoOwner?.attempt === attempt) {
            videoPresentationDetail("peer-finished", {
              outcome,
              ice: peer.iceConnectionState,
              connection: peer.connectionState,
            });
          }
          finished = true;
          offerAbort.abort();
          clearSetupTimer();
          if (statsTimer !== 0) window.clearInterval(statsTimer);
          if (disconnectTimer !== 0) window.clearTimeout(disconnectTimer);
          removeLoadedDataListener();
          if (cancelActiveSession === cancelSession) cancelActiveSession = null;
          clearControlTransport();
          inputChannel.close();
          if (activePeer === peer) {
            activePeer = null;
            activeAttempt = null;
          }
          // Cancelled means replaced or unmounted, and either way the picture it is painting is
          // worth keeping until whatever comes next has one of its own. Anything else is a dead
          // peer with nothing to keep.
          if (outcome === "cancelled") retire(peer, attempt);
          else closePeer(peer, attempt);
          resolve(outcome);
        };
        cancelSession = () => finish("cancelled");
        cancelActiveSession = cancelSession;
        setupTimer = window.setTimeout(() => {
          report("setup-timeout", `ice=${peer.iceConnectionState} connection=${peer.connectionState}`);
          finish(`ICE setup timed out after ${ICE_SETUP_TIMEOUT_MS}ms`);
        }, ICE_SETUP_TIMEOUT_MS);

        peer.addTransceiver("video", { direction: "recvonly" });
        peer.ontrack = (event) => {
          report("track-received", event.track.kind);
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          // The incoming stream decodes off screen until it has a frame. Attaching it to the
          // visible element straight away would replace the previous session's picture with
          // black for the whole negotiation; this is the DeskZoom viewer's promote step, where the
          // incoming stream becomes current only once it has produced a frame.
          const probe = document.createElement("video");
          probe.muted = true;
          probe.playsInline = true;
          probe.srcObject = stream;
          const promote = () => {
            probe.srcObject = null;
            if (cancelled || finished) return;
            retirePrevious();
            attach(stream);
          };
          probe.addEventListener("loadeddata", promote, { once: true });
          void probe.play().catch(() => {
            // Autoplay policy cannot refuse a muted video, and a decode failure surfaces on the
            // visible element's own path once attached; nothing to do here.
          });
        };
        const attach = (stream: MediaStream) => {
          const previousOwner = videoOwner;
          if (
            previousOwner
            && previousOwner.frameRequest !== null
            && typeof element.cancelVideoFrameCallback === "function"
          ) {
            element.cancelVideoFrameCallback(previousOwner.frameRequest);
          }
          videoOwner = {
            attempt,
            report,
            sampleHealth: (reason, gapMs) => void sampleReceiverStats(reason, gapMs),
            frameRequest: null,
            presentedSamples: 0,
            lastPresentedAt: null,
            mediaTime: null,
            gapStartedAt: null,
            lastGapReportAt: null,
            lastGapClassification: null,
          };
          element.srcObject = stream;
          setHasPicture(true);
          videoPresentationDetail("owner-assigned", {
            previousOwner: previousOwner?.attempt ?? null,
          });
          armVideoPresentationSample(videoOwner);
          void element.play().catch((error: unknown) => {
            report("play-rejected", error instanceof Error ? error.message : String(error));
          });
        };
        const onLoadedData = () => {
          if (cancelled) return;
          if (!negotiatedCodec) {
            finish("video frame arrived before codec negotiation");
            return;
          }
          sawFrames = true;
          clearSetupTimer();
          report("first-frame");
          void sampleReceiverStats("first-frame");
          setState({
            kind: "playing",
            codec: `webrtc/${negotiatedCodec}`,
            firstFrameMs: firstEver ? Math.round(performance.now() - started) : 0,
          });
        };
        element.addEventListener("loadeddata", onLoadedData, { once: true });
        removeLoadedDataListener = () => element.removeEventListener("loadeddata", onLoadedData);
        peer.oniceconnectionstatechange = () => {
          report("ice-state", peer.iceConnectionState);
          void sampleReceiverStats(`ice-${peer.iceConnectionState}`);
        };
        peer.onconnectionstatechange = () => {
          const at = peer.connectionState;
          report("connection-state", at);
          void sampleReceiverStats(`connection-${at}`);
          if (at === "connected") {
            if (disconnectTimer !== 0) {
              window.clearTimeout(disconnectTimer);
              disconnectTimer = 0;
            }
            clearSetupTimer();
            if (statsTimer === 0) {
              statsTimer = window.setInterval(
                () => void sampleReceiverStats(),
                RECEIVER_STATS_INTERVAL_MS,
              );
            }
            if (!sawFrames) {
              setupTimer = window.setTimeout(() => {
                report("first-frame-timeout", `ice=${peer.iceConnectionState} connection=${at}`);
                finish(`video track produced no frame after ${FIRST_FRAME_TIMEOUT_MS}ms`);
              }, FIRST_FRAME_TIMEOUT_MS);
            }
          }
          if (at === "disconnected" && disconnectTimer === 0) {
            disconnectTimer = window.setTimeout(() => {
              disconnectTimer = 0;
              if (peer.connectionState === "disconnected") {
                finish(cancelled ? "cancelled" : sawFrames ? "ended" : "peer never connected");
              }
            }, ICE_DISCONNECTED_GRACE_MS);
          }
          if (at === "failed" || at === "closed") {
            finish(cancelled ? "cancelled" : sawFrames ? "ended" : "peer never connected");
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
            if (finished || cancelled) return;
            const capture = captureSize();
            const body = {
              type: "offer",
              sdp: peer.localDescription!.sdp,
              attempt,
              // Retiring after the new stream paints keeps a display handover gapless, but it also
              // leaves the predecessor subscribed while this offer is decided. Naming it lets the
              // sidecar retask the one capture instead of joining this viewer to its own old
              // geometry.
              ...(retiring.current === null ? {} : { supersedes: retiring.current.attempt }),
              ...(resolvedDisplayId === undefined ? {} : { displayId: resolvedDisplayId }),
              ...(capture.width === undefined ? {} : { width: capture.width }),
              ...(capture.height === undefined ? {} : { height: capture.height }),
              ...(capturePlan === null ? {} : { sourceRect: capturePlan.region }),
              fps,
              bitrate: capture.bitrate,
            };
            const response = httpTransport
              ? await httpTransport.request("POST", `/api/park/tile/${windowID}/webrtc`, { body, signal: offerAbort.signal })
              : await fetch(`/api/park/tile/${windowID}/webrtc`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                  signal: offerAbort.signal,
                }).then(async (answer) => ({ status: answer.status, body: await answer.text() }));
            if (response.status < 200 || response.status >= 300) {
              if (!cancelled && response.status === 409 && onDisplayUnavailableRef.current) {
                let failure: Record<string, unknown> | null = null;
                try { failure = JSON.parse(response.body); } catch { /* Report the HTTP failure below. */ }
                if (failure?.code === "display-unavailable" && desktopDisplayId(failure.replacementDisplayId)
                    && failure.replacementDisplayId !== resolvedDisplayId) {
                  onDisplayUnavailableRef.current(failure.replacementDisplayId);
                  finish("cancelled");
                  return;
                }
              }
              finish(
                cancelled
                  ? "cancelled"
                  : response.body.slice(0, 200) || `HTTP ${response.status}`,
              );
              return;
            }
            if (cancelled) {
              finish("cancelled");
              return;
            }
            const answer = parseWebrtcTileAnswer(response.body);
            if (resolvedDisplayId && answer.source.displayId !== resolvedDisplayId) {
              throw new Error("WebRTC source changed monitor identity");
            }
            resolvedDisplayId = answer.source.displayId;
            negotiatedCodec = answer.codec;
            controlCompatible = answer.source.desktopControlVersion === 2;
            if (!controlCompatible) {
              report(
                "control-channel-state",
                `protocol-mismatch host=${answer.source.desktopControlVersion} client=2`,
              );
            }
            report("answer-received");
            onSourceMetadataRef.current?.(answer.source);
            await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
            report("answer-applied");
          } catch (error) {
            finish(cancelled ? "cancelled" : (error as Error).message);
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

    // React runs no cleanup when the document is torn down, so a reload used to leave the sidecar
    // believing this viewer was still watching until ICE consent expired. The reloaded page then
    // offered again, and any change of size made that a second capture of the same display beside
    // the abandoned one -- two ScreenCaptureKit captures of one target, which starve each other
    // into a black picture. Closing both peers here is what makes the reload look like a leave.
    const onPageHide = () => {
      const previous = retiring.current;
      if (previous) postWebrtcClose(previous.attempt, httpTransport);
      if (activeAttempt) postWebrtcClose(activeAttempt, httpTransport);
    };
    window.addEventListener("pagehide", onPageHide);

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
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(presentationTimer);
      window.clearInterval(presentationWatchdogTimer);
      for (const event of videoEvents) element.removeEventListener(event, onVideoEvent);
      if (
        videoOwner
        && videoOwner.frameRequest !== null
        && typeof element.cancelVideoFrameCallback === "function"
      ) {
        element.cancelVideoFrameCallback(videoOwner.frameRequest);
      }
      wake?.();
      cancelActiveSession?.();
      // Not closed and not blanked: the picture stays until the next session has painted, or the
      // retiree's timer runs out. cancelActiveSession has already retired the peer.
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
