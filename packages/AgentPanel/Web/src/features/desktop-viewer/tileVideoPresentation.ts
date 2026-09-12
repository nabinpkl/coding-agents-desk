// Whether the video element is actually presenting frames, and what to say when it stops.
//
// The receiver's own statistics can look healthy while nothing reaches the screen, so this
// watches the element itself: a frame callback per presented frame, a periodic sample, and
// a watchdog that notices a gap and keeps reporting until it closes.

import { postTileTelemetry } from "@/features/desktop-viewer/webrtcTileWire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

const VIDEO_PRESENTATION_INTERVAL_MS = 5_000;
const PRESENTATION_WATCHDOG_INTERVAL_MS = 250;
const PRESENTATION_GAP_THRESHOLD_MS = 750;
const PRESENTATION_GAP_REPORT_INTERVAL_MS = 1_000;

export type VideoPresentationOwner = {
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

export function createVideoPresentationWatch(
  element: HTMLVideoElement,
  windowID: number | string,
  httpTransport: Pick<AgentHttpTransport, "request"> | undefined,
  onFirstFrame: () => void,
) {
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
      if (owner.presentedSamples === 1) onFirstFrame();
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

  return {
    get owner(): VideoPresentationOwner | null { return videoOwner; },
    set owner(next: VideoPresentationOwner | null) { videoOwner = next; },
    detail: videoPresentationDetail,
    arm: armVideoPresentationSample,
    /** Ends every listener, timer and frame callback this watch holds. */
    stop(): void {
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
    },
  };
}
