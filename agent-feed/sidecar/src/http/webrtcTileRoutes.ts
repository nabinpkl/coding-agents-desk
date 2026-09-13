// `POST /api/park/tile/:windowID/webrtc` -- one window as a WebRTC video track.
//
// The transport-only bet, spelled out: the old ADR-0001 pipeline used libwebrtc
// as encoder, transport, AND renderer, and lost on software codecs. Here WebRTC
// is ONLY the transport. Our grid encoder produces hardware H.264 or HEVC, werift
// carries it as SRTP with the feedback machinery (NACK retransmit, PLI keyframe
// requests, connectivity checks), and the webview's built-in WebRTC stack
// hardware-decodes into the compositor. TypeScript's whole job is offer/answer
// and reframing access units into RTP payloads.
//
// What deliberately does NOT exist here, because the transport owns it: no
// live-edge chase, no buffer pruning, no idle sweeper, no reconnect policy.
// A dead peer fails ICE consent and the connection state says so; late packets
// are the jitter buffer's problem on the far side. Even the encoder's bitrate
// is the receiver's number (REMB), not ours.
//
// This file is the route table. Building a peer is `webrtcTileAnswer.ts`, the capture behind it
// `webrtcEncoderPool.ts`, and the evidence either leaves `webrtcDiagnosticsLog.ts` and
// `webrtcConnectionDiagnostics.ts`. It stays the entry point: every importer and every test
// reaches the webrtc tile through this name.

import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";
import { answer } from "./webrtcTileAnswer.ts";
import { recordClientTelemetry, type TileTelemetry } from "./webrtcConnectionDiagnostics.ts";
import { closeWebrtcSessions, webrtcSessionsSnapshot } from "./webrtcSessions.ts";
import { drainEncoderTeardowns } from "./webrtcEncoderPool.ts";
import { ATTEMPT_PATTERN, type TileOffer } from "./webrtcTileOffer.ts";
import { diag } from "./webrtcDiagnosticsLog.ts";
import type { WebrtcSessionsClose } from "./webrtcSessions.ts";

export { WebrtcEncoderDiagnostics } from "./webrtcDiagnosticsLog.ts";
export { writeEncoderControl } from "./webrtcEncoderPool.ts";
export { isTerminalWebrtcConnectionState } from "./webrtcConnectionState.ts";
export { encoderDisposition, encoderStreamKey, type EncoderDisposition } from "./webrtcEncoderIdentity.ts";
export { encoderSourceRect } from "./webrtcTileOffer.ts";
export {
  parseWebrtcDeliveryClientSample,
  WebrtcDeliveryDiagnostics,
  type WebrtcDeliveryClientSample,
  type WebrtcDeliveryServerSample,
} from "./webrtcConnectionDiagnostics.ts";
export {
  closeWebrtcSessions,
  webrtcSessionsSnapshot,
  type WebrtcSessionsClose,
  type WebrtcSessionsSnapshot,
} from "./webrtcSessions.ts";

/** The target is a window id, or the literal `display` for the whole screen. */
const WEBRTC_TILE_ROUTE = /^\/api\/park\/tile\/(\d{1,10}|display)\/webrtc$/;
const WEBRTC_TILE_TELEMETRY_ROUTE =
  /^\/api\/park\/tile\/(\d{1,10}|display)\/webrtc\/telemetry$/;
// Who is watching and what is capturing, and a way to end either. `GET` lists, `POST .../close`
// takes `{attempt}`, `{encoderPid}` or `{all: true}`. The viewer posts its own attempt here when
// it closes a peer: a browser-side close sends nothing on the wire, so without it the sidecar
// learns of the departure only when ICE consent expires thirty seconds later, and the capture
// keeps running for a viewer that has gone.
const WEBRTC_SESSIONS_ROUTE = "/api/park/webrtc/sessions";
const WEBRTC_SESSIONS_CLOSE_ROUTE = "/api/park/webrtc/sessions/close";

export function createWebrtcTileRoutes(
  recordClientDiagnostic: (line: string) => void = diag,
): RouteHandler {
  return (request, url) => {
    if (request.method === "GET" && url.pathname === WEBRTC_SESSIONS_ROUTE) {
      return jsonResponse(webrtcSessionsSnapshot());
    }
    if (request.method !== "POST") return undefined;
    if (url.pathname === WEBRTC_SESSIONS_CLOSE_ROUTE) {
      return (async () => {
        let body: WebrtcSessionsClose;
        try {
          body = (await request.json()) as WebrtcSessionsClose;
        } catch {
          return jsonResponse({ code: "webrtc-bad-close", message: "body was not JSON" }, 400);
        }
        const named = body.attempt !== undefined || body.encoderPid !== undefined || body.all === true;
        if (
          !named
          || (body.attempt !== undefined && !ATTEMPT_PATTERN.test(String(body.attempt)))
          || (body.encoderPid !== undefined && !Number.isInteger(body.encoderPid))
        ) {
          return jsonResponse(
            { code: "webrtc-bad-close", message: "body must name an attempt, an encoderPid, or all" },
            400,
          );
        }
        const reason = body.all === true ? "closed-all" : body.attempt !== undefined ? "viewer-closed" : "encoder-closed";
        return jsonResponse(closeWebrtcSessions(body, reason));
      })();
    }
    const telemetry = WEBRTC_TILE_TELEMETRY_ROUTE.exec(url.pathname);
    if (telemetry) {
      return (async () => {
        let body: TileTelemetry;
        try {
          body = (await request.json()) as TileTelemetry;
        } catch {
          return jsonResponse(
            { code: "webrtc-bad-telemetry", message: "body was not JSON" },
            400,
          );
        }
        return recordClientTelemetry(telemetry[1]!, body, recordClientDiagnostic);
      })();
    }
    const match = WEBRTC_TILE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    return (async () => {
      let body: TileOffer;
      try {
        body = (await request.json()) as TileOffer;
      } catch {
        return jsonResponse({ code: "webrtc-bad-offer", message: "body was not JSON" }, 400);
      }
      return answer(match[1]!, body, request.signal).catch((error: unknown) =>
        jsonResponse(
          {
            code: "webrtc-tile-failed",
            message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          500,
        ),
      );
    })();
  };
}
