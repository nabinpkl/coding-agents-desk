// The webrtc diagnostics log, and the sender-side counters written to it.
//
// Appended per event so a failing surface -- a phone on LTE -- leaves evidence readable on the
// Mac without touching the device. Its own file rather than part of the route, because every
// layer here writes to it and the counters are what a reader of that log is actually reading.

import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimePaths } from "../../../../tools/runtime-paths.mjs";
import { ensureCrossSessionDirectory } from "../crossSessionDirectory.ts";

// Connection diagnostics, appended per event so a failing surface (a phone on
// LTE) leaves evidence readable on the Mac without touching the device. The
// offer SDP carries every ICE candidate the remote webview gathered, which is
// the question that decides whether a path can exist at all.
let diagSequence = 0;
/** One number per connection attempt, so a log line can be tied to the peer that produced it. */
export function nextDiagSequence(): number {
  return ++diagSequence;
}
/** Reported once, not per line: a broken log must not become a flood of its own. */
let diagFailureReported = false;
/** Resolved once; the path cannot change under a running sidecar and the chmod is not free. */
let diagFile: string | undefined;
export function diag(line: string) {
  try {
    if (diagFile === undefined) {
      const file = runtimePaths().webrtcDiagLog;
      ensureCrossSessionDirectory(dirname(file));
      diagFile = file;
    }
    appendFileSync(diagFile, `${new Date().toISOString()} ${line}\n`);
  } catch (error) {
    // Diagnostics never take the media path down, but a silent failure here is worse than it
    // looks: the session goes on serving video while leaving no evidence at all, and its numbers
    // then get read off whichever session does own the file. Say so once, on the way past.
    if (!diagFailureReported) {
      diagFailureReported = true;
      process.stderr.write(`webrtc diagnostics unavailable: ${String(error)}\n`);
    }
  }
}

export type KeyframeRequestReason = "pli" | "bootstrap";

/**
 * Bounded sender-side evidence for the question receiver stats cannot answer:
 * how many requested refreshes became actual keyframes, and what share of the
 * encoded bytes those keyframes consumed. A request count and an output count
 * are deliberately separate because VideoToolbox coalesces repeated force-key
 * requests before the next captured frame.
 */
export class WebrtcEncoderDiagnostics {
  private windowStartedAtMs: number;
  private windowAccessUnits = 0;
  private windowKeyframes = 0;
  private windowDeltaFrames = 0;
  private windowBytes = 0;
  private windowKeyframeBytes = 0;
  private windowPliRequests = 0;
  private windowBootstrapRequests = 0;
  private totalAccessUnits = 0;
  private totalKeyframes = 0;
  private accessUnitsSinceKeyframe = 0;
  private lastKeyframeAtMs: number | null = null;
  private pendingPliRequests = 0;
  private pendingBootstrapRequests = 0;

  constructor(
    private readonly key: string,
    private readonly record: (line: string) => void = diag,
    startedAtMs = Date.now(),
  ) {
    this.windowStartedAtMs = startedAtMs;
  }

  recordKeyframeRequest(reason: KeyframeRequestReason) {
    if (reason === "pli") {
      this.windowPliRequests += 1;
      this.pendingPliRequests += 1;
    } else {
      this.windowBootstrapRequests += 1;
      this.pendingBootstrapRequests += 1;
    }
  }

  recordAccessUnit(bytes: number, keyframe: boolean, atMs = Date.now()) {
    this.totalAccessUnits += 1;
    this.windowAccessUnits += 1;
    this.windowBytes += bytes;
    this.accessUnitsSinceKeyframe += 1;
    if (!keyframe) {
      this.windowDeltaFrames += 1;
      return;
    }

    this.totalKeyframes += 1;
    this.windowKeyframes += 1;
    this.windowKeyframeBytes += bytes;
    const intervalMs = this.lastKeyframeAtMs === null ? -1 : atMs - this.lastKeyframeAtMs;
    const requestContext = this.pendingPliRequests > 0
      ? "pending-pli"
      : this.pendingBootstrapRequests > 0
        ? "pending-bootstrap"
        : this.totalKeyframes === 1
          ? "startup"
          : "none";
    this.record(
      `encoder key=${this.key} keyframe output=${this.totalKeyframes} accessUnit=${this.totalAccessUnits} bytes=${bytes} intervalMs=${intervalMs} accessUnitsSincePrevious=${this.accessUnitsSinceKeyframe} requestContext=${requestContext} pendingPli=${this.pendingPliRequests} pendingBootstrap=${this.pendingBootstrapRequests}`,
    );
    this.lastKeyframeAtMs = atMs;
    this.accessUnitsSinceKeyframe = 0;
    this.pendingPliRequests = 0;
    this.pendingBootstrapRequests = 0;
  }

  flush(atMs = Date.now(), reason = "interval") {
    const durationMs = Math.max(0, atMs - this.windowStartedAtMs);
    const keyframeBytePct = this.windowBytes === 0
      ? "0.0"
      : ((this.windowKeyframeBytes / this.windowBytes) * 100).toFixed(1);
    const lastKeyframeAgeMs = this.lastKeyframeAtMs === null ? -1 : atMs - this.lastKeyframeAtMs;
    this.record(
      `encoder key=${this.key} video-window reason=${reason} durationMs=${durationMs} accessUnits=${this.windowAccessUnits} keyframes=${this.windowKeyframes} deltas=${this.windowDeltaFrames} bytes=${this.windowBytes} keyframeBytes=${this.windowKeyframeBytes} keyframeBytePct=${keyframeBytePct} pliRequests=${this.windowPliRequests} bootstrapRequests=${this.windowBootstrapRequests} pendingPli=${this.pendingPliRequests} totalAccessUnits=${this.totalAccessUnits} totalKeyframes=${this.totalKeyframes} lastKeyframeAgeMs=${lastKeyframeAgeMs}`,
    );
    this.windowStartedAtMs = atMs;
    this.windowAccessUnits = 0;
    this.windowKeyframes = 0;
    this.windowDeltaFrames = 0;
    this.windowBytes = 0;
    this.windowKeyframeBytes = 0;
    this.windowPliRequests = 0;
    this.windowBootstrapRequests = 0;
  }
}

export function candidateLines(sdp: string): string[] {
  return [...sdp.matchAll(/a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/g)].map(
    (m) => `${m[3]} ${m[5]}:${m[6]} typ ${m[7]}`,
  );
}
