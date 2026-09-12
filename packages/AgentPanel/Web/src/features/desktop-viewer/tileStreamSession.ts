// One attempt at a live stream: offer, answer, media, and every way it can end.
//
// The mutable slots the attempt writes into (`live`) belong to the effect that owns the
// reconnect loop, and are handed over by reference rather than copied: a retired peer, the
// attempt id a page teardown reports, and the resolved display all outlive one attempt.

import type { Dispatch, RefObject, SetStateAction } from "react";
import { desktopDisplayId } from "@agentdesk/agent-feed-wire";
import type {
  DesktopControlEvent,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import type { CapturePlan } from "./tileCapturePlan";
import { createControlChannel } from "./tileControlChannel";
import { createReceiverStatsSampler } from "./tileReceiverStats";
import type { createVideoPresentationWatch } from "./tileVideoPresentation";
import { RECEIVER_STATS_INTERVAL_MS } from "./webrtcReceiverStats";
import {
  parseWebrtcTileAnswer,
  postTileTelemetry,
  postWebrtcClose,
  type DesktopControlTransport,
} from "./webrtcTileWire";

/** How long a replaced session's picture is kept when nothing comes after it. */
export const RETIRE_TIMEOUT_MS = 4_000;
// WebKit can leave a peer in `connecting` forever when no candidate pair is
// viable. A setup attempt either connects inside this window or yields to the
// existing reconnect loop with an explicit diagnostic phase.
export const ICE_SETUP_TIMEOUT_MS = 12_000;
export const FIRST_FRAME_TIMEOUT_MS = 12_000;
const ICE_DISCONNECTED_GRACE_MS = 8_000;
// Fast Refresh preserves mounted effects when their dependency values do not
// change. Bump this only when live diagnostic ownership itself changes so the
// running WebView adopts that instrumentation without a reload or relaunch.
export const VIDEO_DIAGNOSTIC_REVISION = 13;

/** What one attempt writes down for the next one, and for the effect's own teardown. */
export interface TileSessionRuntime {
  cancelled: boolean;
  /** Resolved once; a reconnect must retain the same physical screen. */
  resolvedDisplayId: string | undefined;
  activePeer: RTCPeerConnection | null;
  activeAttempt: string | null;
  cancelActiveSession: (() => void) | null;
  wake: (() => void) | null;
  activeControlTransport: DesktopControlTransport | null;
}

export interface TileSessionDeps {
  closePeer: (peer: RTCPeerConnection, attempt: string) => void;
  retirePrevious: () => void;
  retire: (peer: RTCPeerConnection, attempt: string) => void;
  publishControlTransport: (transport: DesktopControlTransport | null) => void;
  captureSize: () => { width?: number; height?: number; bitrate: number };
  presentation: ReturnType<typeof createVideoPresentationWatch>;
  capturePlan: CapturePlan | null;
  element: HTMLVideoElement;
  setState: Dispatch<SetStateAction<DesktopStreamState>>;
  setHasPicture: Dispatch<SetStateAction<boolean>>;
  retiring: RefObject<{ peer: RTCPeerConnection; attempt: string; timer: number } | null>;
  httpTransport: Pick<AgentHttpTransport, "request"> | undefined;
  windowID: number | "display";
  control: boolean;
  fps: number | undefined;
  displayId: string | undefined;
  onSourceMetadataRef: RefObject<((source: WebrtcTileSourceMetadata) => void) | undefined>;
  onControlEventRef: RefObject<((event: DesktopControlEvent) => void) | undefined>;
  onDisplayUnavailableRef: RefObject<((replacementDisplayId: string) => void) | undefined>;
}

/** Resolves "ended" on peer death, "failed" when setup itself broke. */
export const runTileSession = (
  live: TileSessionRuntime,
  deps: TileSessionDeps,
  firstEver: boolean,
): Promise<"ended" | "cancelled" | string> =>
  new Promise((resolve) => {
    const started = performance.now();
    const peer = new RTCPeerConnection();
    const offerAbort = new AbortController();
    live.activePeer = peer;
    let sawFrames = false;
    let finished = false;
    let negotiatedCodec: WebrtcTileAnswer["codec"] | null = null;
    let controlCompatible = false;
    const attempt = crypto.randomUUID();
    // Named here so a document teardown can report this peer gone; see `onPageHide`.
    live.activeAttempt = attempt;
    const report = (phase: string, detail?: string) => {
      postTileTelemetry(deps.windowID, {
        attempt,
        phase,
        detail,
        elapsedMs: Math.round(performance.now() - started),
      }, deps.httpTransport);
    };
    const { clearControlTransport, inputChannel } = createControlChannel({
      control: deps.control,
      finish: (outcome) => finish(outcome),
      isCompatible: () => controlCompatible,
      isPublished: (transport) => live.activeControlTransport === transport,
      onControlEvent: (event) => deps.onControlEventRef.current?.(event),
      peer,
      publishControlTransport: deps.publishControlTransport,
      report,
    });
    const sampleReceiverStats = createReceiverStatsSampler({
      attempt,
      element: deps.element,
      httpTransport: deps.httpTransport,
      isFinished: () => finished,
      peer,
      presentation: deps.presentation,
      report,
      windowID: deps.windowID,
    });
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
      if (deps.presentation.owner?.attempt === attempt) {
        deps.presentation.detail("peer-finished", {
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
      if (live.cancelActiveSession === cancelSession) live.cancelActiveSession = null;
      clearControlTransport();
      inputChannel.close();
      if (live.activePeer === peer) {
        live.activePeer = null;
        live.activeAttempt = null;
      }
      // Cancelled means replaced or unmounted, and either way the picture it is painting is
      // worth keeping until whatever comes next has one of its own. Anything else is a dead
      // peer with nothing to keep.
      if (outcome === "cancelled") deps.retire(peer, attempt);
      else deps.closePeer(peer, attempt);
      resolve(outcome);
    };
    cancelSession = () => finish("cancelled");
    live.cancelActiveSession = cancelSession;
    setupTimer = window.setTimeout(() => {
      report("setup-timeout", `ice=${peer.iceConnectionState} connection=${peer.connectionState}`);
      finish(`ICE setup timed out after ${ICE_SETUP_TIMEOUT_MS}ms`);
    }, ICE_SETUP_TIMEOUT_MS);

    peer.addTransceiver("video", { direction: "recvonly" });
    peer.ontrack = (event) => {
      report("track-received", event.track.kind);
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      // The incoming stream decodes off screen until it has a frame. Attaching it to the
      // visible deps.element straight away would replace the previous session's picture with
      // black for the whole negotiation; this is the DeskZoom viewer's promote step, where the
      // incoming stream becomes current only once it has produced a frame.
      const probe = document.createElement("video");
      probe.muted = true;
      probe.playsInline = true;
      probe.srcObject = stream;
      const promote = () => {
        probe.srcObject = null;
        if (live.cancelled || finished) return;
        deps.retirePrevious();
        attach(stream);
      };
      probe.addEventListener("loadeddata", promote, { once: true });
      void probe.play().catch(() => {
        // Autoplay policy cannot refuse a muted video, and a decode failure surfaces on the
        // visible element's own path once attached; nothing to do here.
      });
    };
    const attach = (stream: MediaStream) => {
      const previousOwner = deps.presentation.owner;
      if (
        previousOwner
        && previousOwner.frameRequest !== null
        && typeof deps.element.cancelVideoFrameCallback === "function"
      ) {
        deps.element.cancelVideoFrameCallback(previousOwner.frameRequest);
      }
      deps.presentation.owner = {
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
      deps.element.srcObject = stream;
      deps.setHasPicture(true);
      deps.presentation.detail("owner-assigned", {
        previousOwner: previousOwner?.attempt ?? null,
      });
      deps.presentation.arm(deps.presentation.owner);
      void deps.element.play().catch((error: unknown) => {
        report("play-rejected", error instanceof Error ? error.message : String(error));
      });
    };
    const onLoadedData = () => {
      if (live.cancelled) return;
      if (!negotiatedCodec) {
        finish("video frame arrived before codec negotiation");
        return;
      }
      sawFrames = true;
      clearSetupTimer();
      report("first-frame");
      void sampleReceiverStats("first-frame");
      deps.setState({
        kind: "playing",
        codec: `webrtc/${negotiatedCodec}`,
        firstFrameMs: firstEver ? Math.round(performance.now() - started) : 0,
      });
    };
    deps.element.addEventListener("loadeddata", onLoadedData, { once: true });
    removeLoadedDataListener = () => deps.element.removeEventListener("loadeddata", onLoadedData);
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
            finish(live.cancelled ? "cancelled" : sawFrames ? "ended" : "peer never connected");
          }
        }, ICE_DISCONNECTED_GRACE_MS);
      }
      if (at === "failed" || at === "closed") {
        finish(live.cancelled ? "cancelled" : sawFrames ? "ended" : "peer never connected");
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
        if (finished || live.cancelled) return;
        const capture = deps.captureSize();
        const body = {
          type: "offer",
          sdp: peer.localDescription!.sdp,
          attempt,
          // Retiring after the new stream paints keeps a display handover gapless, but it also
          // leaves the predecessor subscribed while this offer is decided. Naming it lets the
          // sidecar retask the one capture instead of joining this viewer to its own old
          // geometry.
          ...(deps.retiring.current === null ? {} : { supersedes: deps.retiring.current.attempt }),
          ...(live.resolvedDisplayId === undefined ? {} : { displayId: live.resolvedDisplayId }),
          ...(capture.width === undefined ? {} : { width: capture.width }),
          ...(capture.height === undefined ? {} : { height: capture.height }),
          ...(deps.capturePlan === null ? {} : { sourceRect: deps.capturePlan.region }),
          fps: deps.fps,
          bitrate: capture.bitrate,
        };
        const response = deps.httpTransport
          ? await deps.httpTransport.request("POST", `/api/park/tile/${deps.windowID}/webrtc`, { body, signal: offerAbort.signal })
          : await fetch(`/api/park/tile/${deps.windowID}/webrtc`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: offerAbort.signal,
            }).then(async (answer) => ({ status: answer.status, body: await answer.text() }));
        if (response.status < 200 || response.status >= 300) {
          if (!live.cancelled && response.status === 409 && deps.onDisplayUnavailableRef.current) {
            let failure: Record<string, unknown> | null = null;
            try { failure = JSON.parse(response.body); } catch { /* Report the HTTP failure below. */ }
            if (failure?.code === "display-unavailable" && desktopDisplayId(failure.replacementDisplayId)
                && failure.replacementDisplayId !== live.resolvedDisplayId) {
              deps.onDisplayUnavailableRef.current(failure.replacementDisplayId);
              finish("cancelled");
              return;
            }
          }
          finish(
            live.cancelled
              ? "cancelled"
              : response.body.slice(0, 200) || `HTTP ${response.status}`,
          );
          return;
        }
        if (live.cancelled) {
          finish("cancelled");
          return;
        }
        const answer = parseWebrtcTileAnswer(response.body);
        if (live.resolvedDisplayId && answer.source.displayId !== live.resolvedDisplayId) {
          throw new Error("WebRTC source changed monitor identity");
        }
        live.resolvedDisplayId = answer.source.displayId;
        negotiatedCodec = answer.codec;
        controlCompatible = answer.source.desktopControlVersion === 2;
        if (!controlCompatible) {
          report(
            "control-channel-state",
            `protocol-mismatch host=${answer.source.desktopControlVersion} client=2`,
          );
        }
        report("answer-received");
        deps.onSourceMetadataRef.current?.(answer.source);
        await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        report("answer-applied");
      } catch (error) {
        finish(live.cancelled ? "cancelled" : (error as Error).message);
      }
    })();
  });
