// Who is watching and what is capturing, and the two ways either ends.
//
// A census over the same records the diagnostics log is written from, exposed because the
// question "is anything still streaming" is one a person asks from a terminal (`just
// webrtc-sessions`) far more often than from the panel.

import { killSharedEncoder, sharedEncoders, type SharedEncoder } from "@/http/tile/tile-encoder/webrtcEncoderPool";
import { diag } from "@/http/tile/tile-diagnostics/webrtcDiagnosticsLog";
import { connectionDiagnostics } from "@/http/tile/tile-diagnostics/webrtcConnectionDiagnostics";
import type { TileVideoCodec } from "@/http/tile/tile-codec/webrtcTileCodec";
import { basename } from "node:path";

export interface WebrtcSessionsSnapshot {
  connections: Array<{
    attempt: string;
    connection: number;
    windowID: string;
    ageMs: number;
    iceState: string;
    connectionState: string;
    transportReady: boolean;
    sentAccessUnits: number;
    lastSentAgeMs: number | null;
    encoder: string | null;
  }>;
  encoders: Array<{
    key: string;
    pid: number;
    binary: string;
    codec: TileVideoCodec;
    subscribers: number;
    accessUnits: number;
    lastAccessUnitAgeMs: number | null;
    lingering: boolean;
  }>;
}

export function webrtcSessionsSnapshot(nowMs = Date.now()): WebrtcSessionsSnapshot {
  const connections: WebrtcSessionsSnapshot["connections"] = [];
  for (const c of connectionDiagnostics.values()) {
    if (c.closedAtMs !== null) continue;
    connections.push({
      attempt: c.attempt,
      connection: c.connection,
      windowID: c.windowID,
      ageMs: nowMs - c.createdAtMs,
      iceState: c.iceState,
      connectionState: c.connectionState,
      transportReady: c.transportReady,
      sentAccessUnits: c.sentAccessUnits,
      lastSentAgeMs: c.lastSentAtMs === null ? null : nowMs - c.lastSentAtMs,
      encoder: c.encoder?.key ?? null,
    });
  }
  const encoders: WebrtcSessionsSnapshot["encoders"] = [];
  for (const e of sharedEncoders.values()) {
    if (e.dead) continue;
    encoders.push({
      key: e.key,
      pid: e.child.pid,
      binary: basename(e.binary),
      codec: e.codec,
      subscribers: e.subscribers.size,
      accessUnits: e.accessUnits,
      lastAccessUnitAgeMs: e.lastAccessUnitAtMs === null ? null : nowMs - e.lastAccessUnitAtMs,
      lingering: e.linger !== null,
    });
  }
  return { connections, encoders };
}

/**
 * Ends the peer a new offer says it is taking over from, so the encoder decision below sees the
 * viewers that are actually still watching.
 */
export function releaseSupersededViewer(attempt: string, streamKey: string) {
  const previous = connectionDiagnostics.get(attempt);
  if (!previous || previous.closedAtMs !== null || previous.shutdown === null) return;
  if (previous.encoder?.key !== streamKey) return;
  diag(`c${previous.connection} superseded on ${streamKey} by a new offer`);
  previous.shutdown("superseded");
}

export interface WebrtcSessionsClose {
  attempt?: string;
  encoderPid?: number;
  all?: boolean;
}

/** Closes what the request names. Idempotent: a viewer reports every close, including of peers already gone. */
export function closeWebrtcSessions(request: WebrtcSessionsClose, reason: string): {
  closedConnections: string[];
  stoppedEncoders: string[];
} {
  const closedConnections: string[] = [];
  const stoppedEncoders: string[] = [];
  for (const c of connectionDiagnostics.values()) {
    if (c.closedAtMs !== null || c.shutdown === null) continue;
    if (request.all === true || c.attempt === request.attempt) {
      c.shutdown(reason);
      closedConnections.push(c.attempt);
    }
  }
  for (const e of [...sharedEncoders.values()]) {
    if (e.dead) continue;
    if (request.all === true || e.child.pid === request.encoderPid) {
      killSharedEncoder(e, reason);
      stoppedEncoders.push(e.key);
    }
  }
  return { closedConnections, stoppedEncoders };
}
