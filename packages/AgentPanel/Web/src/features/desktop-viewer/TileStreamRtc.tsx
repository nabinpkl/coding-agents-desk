"use client";

import { useEffect, useRef, useState } from "react";
import type { WebrtcPointerInput } from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";

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
const RECEIVER_STATS_INTERVAL_MS = 10_000;
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
const POINTER_CHANNEL_LABEL = "agentdesk-pointer-v1";
const POINTER_MOVE_BUFFER_LIMIT = 64 * 1024;

export interface PointerInputTransport {
  send(input: WebrtcPointerInput): boolean;
}

type ReceiverVideoStats = RTCInboundRtpStreamStats & {
  mediaType?: string;
  packetsRepaired?: number;
  powerEfficientDecoder?: boolean;
};

export function TileStreamRtc({
  windowID,
  width,
  height,
  fps = 15,
  bitrate = 1_200_000,
  fill = false,
  onState,
  onPointerTransport,
  httpTransport,
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
  onPointerTransport?: (transport: PointerInputTransport | null) => void;
  /** Control-plane HTTP transport; omitted callers use same-origin fetch. */
  httpTransport?: Pick<AgentHttpTransport, "request">;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DesktopStreamState>({ kind: "connecting" });
  const onPointerTransportRef = useRef(onPointerTransport);

  useEffect(() => {
    onPointerTransportRef.current = onPointerTransport;
  }, [onPointerTransport]);

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
    let cancelActiveSession: (() => void) | null = null;
    let wake: (() => void) | null = null;
    let activePointerTransport: PointerInputTransport | null = null;

    const publishPointerTransport = (transport: PointerInputTransport | null) => {
      activePointerTransport = transport;
      onPointerTransportRef.current?.(transport);
    };

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
        let finished = false;
        const attempt = crypto.randomUUID();
        const report = (phase: string, detail?: string) => {
          const body = {
            attempt,
            phase,
            detail,
            elapsedMs: Math.round(performance.now() - started),
          };
          const request = httpTransport
            ? httpTransport.request(
                "POST",
                `/api/park/tile/${windowID}/webrtc/telemetry`,
                { body },
              )
            : fetch(`/api/park/tile/${windowID}/webrtc/telemetry`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              });
          void request.catch(() => {
            // The Mac-side log is best effort. The connection state and retry
            // remain authoritative when the control request cannot get out.
          });
        };
        const inputChannel = peer.createDataChannel(POINTER_CHANNEL_LABEL, { ordered: true });
        const pointerTransport: PointerInputTransport = {
          send(input) {
            if (inputChannel.readyState !== "open") return false;
            if (input.t === "move" && inputChannel.bufferedAmount > POINTER_MOVE_BUFFER_LIMIT) {
              return false;
            }
            inputChannel.send(JSON.stringify(input));
            return true;
          },
        };
        const clearPointerTransport = () => {
          if (activePointerTransport === pointerTransport) publishPointerTransport(null);
        };
        inputChannel.onopen = () => {
          report("input-channel-state", "open");
          publishPointerTransport(pointerTransport);
        };
        inputChannel.onclose = () => {
          report("input-channel-state", "closed");
          clearPointerTransport();
        };
        inputChannel.onerror = () => {
          report("input-channel-state", "error");
          clearPointerTransport();
        };
        let statsInFlight = false;
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
        const sampleReceiverStats = async () => {
          if (finished || statsInFlight) return;
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
              ? stats.get(transport.selectedCandidatePairId) as RTCIceCandidatePairStats | undefined
              : undefined;
            report("receiver-stats", JSON.stringify({
              packetsReceived: rounded(inbound.packetsReceived),
              packetsLost: rounded(inbound.packetsLost),
              packetsRepaired: rounded(inbound.packetsRepaired),
              packetsDiscarded: rounded(inbound.packetsDiscarded),
              jitterMs: rounded(inbound.jitter, 1_000),
              framesReceived: rounded(inbound.framesReceived),
              framesDecoded: rounded(inbound.framesDecoded),
              framesDropped: rounded(inbound.framesDropped),
              jitterBufferMs: averageMilliseconds(
                inbound.jitterBufferDelay,
                inbound.jitterBufferEmittedCount,
              ),
              jitterTargetMs: averageMilliseconds(
                inbound.jitterBufferTargetDelay,
                inbound.jitterBufferEmittedCount,
              ),
              decodeMs: averageMilliseconds(inbound.totalDecodeTime, inbound.framesDecoded),
              nackCount: rounded(inbound.nackCount),
              pliCount: rounded(inbound.pliCount),
              rttMs: rounded(candidatePair?.currentRoundTripTime, 1_000),
              incomingKbps: rounded(candidatePair?.availableIncomingBitrate, 1 / 1_000),
              decoder: inbound.decoderImplementation,
              powerEfficient: inbound.powerEfficientDecoder,
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
          }
        };
        let setupTimer = 0;
        let statsTimer = 0;
        let removeLoadedDataListener = () => {};
        const clearSetupTimer = () => {
          if (setupTimer === 0) return;
          window.clearTimeout(setupTimer);
          setupTimer = 0;
        };
        let cancelSession: (() => void) | null = null;
        const finish = (outcome: "ended" | "cancelled" | string) => {
          if (finished) return;
          finished = true;
          clearSetupTimer();
          if (statsTimer !== 0) window.clearInterval(statsTimer);
          removeLoadedDataListener();
          if (cancelActiveSession === cancelSession) cancelActiveSession = null;
          clearPointerTransport();
          inputChannel.close();
          peer.close();
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
          element.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void element.play().catch((error: unknown) => {
            report("play-rejected", error instanceof Error ? error.message : String(error));
          });
        };
        const onLoadedData = () => {
          if (cancelled) return;
          sawFrames = true;
          clearSetupTimer();
          report("first-frame");
          void sampleReceiverStats();
          setState({
            kind: "playing",
            codec: "webrtc/h264",
            firstFrameMs: firstEver ? Math.round(performance.now() - started) : 0,
          });
        };
        element.addEventListener("loadeddata", onLoadedData, { once: true });
        removeLoadedDataListener = () => element.removeEventListener("loadeddata", onLoadedData);
        peer.oniceconnectionstatechange = () => {
          report("ice-state", peer.iceConnectionState);
        };
        peer.onconnectionstatechange = () => {
          const at = peer.connectionState;
          report("connection-state", at);
          if (at === "connected") {
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
          if (at === "failed" || at === "closed" || at === "disconnected") {
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
            const capture = captureSize();
            const body = {
              type: "offer",
              sdp: peer.localDescription!.sdp,
              width: capture.width,
              height: capture.height,
              fps,
              bitrate: capture.bitrate,
            };
            const response = httpTransport
              ? await httpTransport.request("POST", `/api/park/tile/${windowID}/webrtc`, { body })
              : await fetch(`/api/park/tile/${windowID}/webrtc`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                }).then(async (answer) => ({ status: answer.status, body: await answer.text() }));
            if (response.status < 200 || response.status >= 300) {
              finish(
                cancelled
                  ? "cancelled"
                  : response.body.slice(0, 200) || `HTTP ${response.status}`,
              );
              return;
            }
            const answer = JSON.parse(response.body) as { sdp: string };
            report("answer-received");
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
      cancelActiveSession?.();
      activePeer?.close();
      publishPointerTransport(null);
      element.srcObject = null;
    };
  }, [windowID, width, height, fps, bitrate, httpTransport]);

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
