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

import type {
  DesktopControlEvent,
  DesktopControlInput,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { networkInterfaces } from "node:os";
import { desktopDisplayId } from "@agentdesk/agent-feed-wire";
import { controlHelper } from "../desktop/controlHelper.ts";
import { resolveDisplayTarget, DisplayTargetUnavailable } from "./webrtcDisplayTarget.ts";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCDataChannel,
  type RTCRtpHistoryRepairStats,
  RtpHeader,
  RtpPacket,
} from "werift";
import { config } from "../config.ts";
import { helperBinary, missingHelperMessage } from "../desktop/helperBinary.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";
import { frames, KIND_META } from "./tileEncoderPool.ts";
import { packetizeH264 } from "./h264Packetizer.ts";
import { packetizeH265 } from "./h265Packetizer.ts";
import {
  desktopControlInput,
  desktopControlLine,
  desktopControlRejectionReason,
} from "./webrtcDesktopControl.ts";
import { WebrtcDesktopControlEvents } from "./webrtcDesktopControlEvents.ts";
import { DesktopControlOwnership } from "./webrtcDesktopControlOwnership.ts";
import { chooseTileVideoCodec, type TileVideoCodec } from "./webrtcTileCodec.ts";
import { gridEncoderSourceMetadata } from "./webrtcTileMetadata.ts";

/** The target is a window id, or the literal `display` for the whole screen. */
const WEBRTC_TILE_ROUTE = /^\/api\/park\/tile\/(\d{1,10}|display)\/webrtc$/;
const WEBRTC_TILE_TELEMETRY_ROUTE =
  /^\/api\/park\/tile\/(\d{1,10}|display)\/webrtc\/telemetry$/;

export function isTerminalWebrtcConnectionState(state: string): boolean {
  return state === "failed" || state === "closed";
}

// Connection diagnostics, appended per event so a failing surface (a phone on
// LTE) leaves evidence readable on the Mac without touching the device. The
// offer SDP carries every ICE candidate the remote webview gathered, which is
// the question that decides whether a path can exist at all.
let diagSequence = 0;
function diag(line: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").appendFileSync(
      "/tmp/agentdesk-webrtc-diag.log",
      `${new Date().toISOString()} ${line}\n`,
    );
  } catch {
    // Diagnostics never take the path down.
  }
}

type KeyframeRequestReason = "pli" | "bootstrap" | "bitrate-recovery";

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

function candidateLines(sdp: string): string[] {
  return [...sdp.matchAll(/a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/g)].map(
    (m) => `${m[3]} ${m[5]}:${m[6]} typ ${m[7]}`,
  );
}

/** Kind 3 in the encoder framing: one Annex-B access unit. */
const KIND_ACCESS_UNIT = 3;
const KIND_CONTROL = 4;

/**
 * The Mac's tailnet address, derived from the CGNAT range tailscale uses.
 *
 * werift's own interface scan skips utun devices, so without this the answer
 * advertises only the LAN address, public IPv6, and a STUN reflexive -- none
 * of which a phone on LTE can reach (measured: exactly that candidate list,
 * and a phone that connected on the home WiFi but only ever said reconnecting
 * on LTE). The tailnet address is the one path that exists regardless of what
 * network either end sits on; the phone's checks toward it route through its
 * own tunnel, and the reply address they arrive from gives werift the working
 * pair. Re-read per connection, because tailscale can come up after the
 * sidecar did.
 */
function tailnetIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      const octets = address.address.split(".").map(Number);
      if (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) return address.address;
    }
  }
  return null;
}

// werift negotiates by mimeType alone and adopts the browser's own codec
// entries; the fmtp below never constrains anything. Which of the browser's
// entries the sender actually stamps on packets is chosen after negotiation,
// in answer(), because the receiver enforces the profile of the payload type
// it receives.
//
// Deliberately NO transport-wide-cc header extension. Negotiating it makes the
// browser use TWCC feedback, which feeds werift's sender-side estimator, and
// that estimator assumes a saturating sender: it emits only on windows of
// twenty-plus acked packets and reads a quiet second as congestion, so a
// mostly-static window never produces an estimate at all (measured: 191 TWCC
// feedbacks in, zero estimates out). Without TWCC the browser falls back to
// REMB, its own receiver-side estimator telling us a number directly, which is
// both the more battle-tested estimator and the more minimal arrangement: the
// receiver decides, the encoder obeys.
const RTCP_FEEDBACK = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "goog-remb" },
];

const H265 = new RTCRtpCodecParameters({
  mimeType: "video/H265",
  clockRate: 90000,
  rtcpFeedback: RTCP_FEEDBACK,
  // These are RFC 7798's defaults, stated explicitly so our packetizer's
  // absence of DONL/DOND and its one-stream ordering contract are visible.
  parameters: "tx-mode=SRST;sprop-max-don-diff=0",
});

const H264 = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  rtcpFeedback: RTCP_FEEDBACK,
  parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
});

/**
 * One encoder per WINDOW, shared by every viewer, keyed by window alone.
 *
 * Not an optimization: two ScreenCaptureKit captures of the same window starve
 * each other (measured on the MSE path at 48ms apart, and measured again here
 * when a reconnect overlapped the old session's encoder, which outlives its
 * dead peer by the ICE consent timeout, so BOTH captures sat at zero frames).
 * Since overlap is guaranteed by the reconnect flow, the second capture must
 * never exist. The first viewer's geometry and profile win; a later viewer of
 * the same window joins the running stream and its element scales the picture.
 */
interface SharedEncoder {
  key: string;
  /**
   * The spawn arguments that decide what this child captures and at what size, minus the ones it
   * can be told to change while running. Reuse is keyed on the display, so without this a viewer
   * asking for a new capture resolution was handed the encoder started at the old one and nothing
   * appeared to happen -- the helper takes --width and --height only at spawn.
   */
  identity: string;
  /** Size it is currently encoding at, which a resize can move without replacing the child. */
  captureWidth?: number;
  captureHeight?: number;
  /**
   * Installed stamp of the binary this child was spawned from. Reuse is keyed on the window, so
   * without this an updated helper would be shadowed by the previous process for
   * as long as one viewer stayed connected, and `just grid-encoder-install` would look like it
   * had done nothing.
   */
  binaryMtimeMs: number;
  codec: TileVideoCodec;
  child: ReturnType<typeof Bun.spawn>;
  subscribers: Set<EncoderSubscriber>;
  latestKeyframe: Uint8Array | null;
  accessUnits: number;
  lastAccessUnitAtMs: number | null;
  firstAccessUnitDeadline: ReturnType<typeof setTimeout> | null;
  linger: ReturnType<typeof setTimeout> | null;
  dead: boolean;
  controlEvents: WebrtcDesktopControlEvents;
  sourceMetadata: WebrtcTileSourceMetadata | null;
  metadataWaiters: Set<EncoderMetadataWaiter>;
  nextInputRevision: number;
  pendingCursorAcks: Map<number, PendingCursorAck>;
  videoDiagnostics: WebrtcEncoderDiagnostics;
  videoDiagnosticsTimer: ReturnType<typeof setInterval>;
}

interface EncoderMetadataWaiter {
  resolve: (metadata: WebrtcTileSourceMetadata) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingCursorAck {
  inputOwner: symbol;
  clientRevision: number;
}

interface EncoderSubscriber {
  inputOwner: symbol;
  /** One access-unit payload: 8 bytes pts-microseconds, 1 keyframe byte, Annex-B. */
  onAccessUnit: (payload: Uint8Array) => void;
  onControl: (event: DesktopControlEvent) => void;
  /** The encoder died; the connection has nothing left to send. */
  onDead: () => void;
}

const sharedEncoders = new Map<string, SharedEncoder>();
// Input affects the whole Mac, even when two peers capture different monitors.
const controlOwnership = new DesktopControlOwnership<symbol>();
const controlOwners = new Map<symbol, { encoder: SharedEncoder; revoke: (epoch: number) => void }>();
const FIRST_ACCESS_UNIT_TIMEOUT_MS = 12_000;
const ENCODER_METADATA_TIMEOUT_MS = 5_000;
const ENCODER_LINGER_MS = 3_000;
/**
 * Bits per pixel per second the encoder is allowed to reach for. Around this, H.265 keeps small
 * text readable; well under it, edges turn to mush no matter how many pixels are being sent.
 */
const TARGET_BITS_PER_PIXEL = 0.12;
/**
 * How far the budget must recover before the picture is worth asking for again. Keyframes are
 * expensive and unrequested ones burst a metered link, so this refreshes on a real change of
 * circumstance rather than on every fluctuation.
 */
const KEYFRAME_ON_RECOVERY_FACTOR = 1.8;
/**
 * Children killed but not yet reaped.
 *
 * ScreenCaptureKit starves a capture that starts while another is tearing down: it delivers zero
 * frames and never recovers, which grid-encoder can only discover by dying ten seconds later --
 * long after the viewer switching monitors has given up. So a spawn waits for the previous
 * teardown instead of racing it. Bounded, because a child that will not exit must not become a
 * reason no capture can ever start.
 */
const encoderTeardowns = new Set<Promise<unknown>>();
const TEARDOWN_DRAIN_TIMEOUT_MS = 2_000;

function trackEncoderTeardown(child: { exited: Promise<unknown> }): void {
  const settled = child.exited.catch(() => undefined);
  encoderTeardowns.add(settled);
  void settled.finally(() => encoderTeardowns.delete(settled));
}

async function drainEncoderTeardowns(): Promise<void> {
  if (encoderTeardowns.size === 0) return;
  await Promise.race([
    Promise.allSettled([...encoderTeardowns]),
    Bun.sleep(TEARDOWN_DRAIN_TIMEOUT_MS),
  ]);
}
const MAX_PENDING_CURSOR_ACKS = 2_048;

interface EncoderControlSink {
  write(line: string): unknown;
  flush(): number | Promise<number>;
}

export function writeEncoderControl(
  stdin: EncoderControlSink | number | null | undefined,
  line: string,
  onError: (error: unknown) => void,
): boolean {
  if (!stdin || typeof stdin === "number") {
    onError(new Error("grid encoder stdin is unavailable"));
    return false;
  }
  try {
    stdin.write(line);
    void Promise.resolve(stdin.flush()).catch(onError);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

function encoderStdin(shared: SharedEncoder, line: string) {
  writeEncoderControl(shared.child.stdin, line, (error) => {
    diag(`encoder key=${shared.key} control-write-failed error=${String(error)}`);
    killSharedEncoder(shared, "encoder-control-write-failed");
  });
}

/**
 * What a running child cannot be re-tasked to do.
 *
 * Bitrate is excluded because the control channel adjusts it live. Size is NOT, though the helper
 * can be resized in place: a compression session is built with whatever bitrate the encoder holds,
 * and on an idle desktop the estimator has already walked that down to its floor, so a session
 * rebuilt at a new size encodes its keyframe at the floor and an infinite GOP leaves that picture
 * on screen. A replacement child starts from the offer's bitrate instead and encodes a generous
 * keyframe. Replacing therefore looks markedly better on a still desktop, and it costs one
 * reconnect, so size stays part of what makes a child the wrong child.
 */
function captureIdentity(args: readonly string[]): string {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--bitrate") {
      index += 1;
      continue;
    }
    kept.push(args[index]!);
  }
  return kept.join(" ");
}

/** The encoded size these arguments ask for, if they name one. Sizes the bitrate ceiling. */
function captureSize(args: readonly string[]): { width?: number; height?: number } {
  const read = (flag: string) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const value = Number(args[at + 1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  return { width: read("--width"), height: read("--height") };
}

function killSharedEncoder(shared: SharedEncoder, reason: string) {
  if (shared.dead) return;
  diag(
    `encoder key=${shared.key} stop reason=${reason} accessUnits=${shared.accessUnits} subscribers=${shared.subscribers.size}`,
  );
  shared.dead = true;
  if (sharedEncoders.get(shared.key) === shared) sharedEncoders.delete(shared.key);
  if (shared.firstAccessUnitDeadline) clearTimeout(shared.firstAccessUnitDeadline);
  if (shared.linger) clearTimeout(shared.linger);
  clearInterval(shared.videoDiagnosticsTimer);
  shared.videoDiagnostics.flush(Date.now(), "encoder-stop");
  for (const waiter of shared.metadataWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error(`grid encoder stopped before source metadata: ${reason}`));
  }
  shared.metadataWaiters.clear();
  try {
    shared.child.kill();
    trackEncoderTeardown(shared.child);
  } catch {
    // Already gone.
  }
  for (const subscriber of [...shared.subscribers]) subscriber.onDead();
  shared.subscribers.clear();
  shared.pendingCursorAcks.clear();
}

function publishEncoderMetadata(shared: SharedEncoder, metadata: WebrtcTileSourceMetadata) {
  if (shared.sourceMetadata) return;
  shared.sourceMetadata = metadata;
  for (const waiter of shared.metadataWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(metadata);
  }
  shared.metadataWaiters.clear();
}

function waitForEncoderMetadata(shared: SharedEncoder): Promise<WebrtcTileSourceMetadata> {
  if (shared.sourceMetadata) return Promise.resolve(shared.sourceMetadata);
  if (shared.dead) return Promise.reject(new Error("grid encoder stopped before source metadata"));
  return new Promise((resolve, reject) => {
    const waiter: EncoderMetadataWaiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        shared.metadataWaiters.delete(waiter);
        reject(new Error(`grid encoder source metadata timed out after ${ENCODER_METADATA_TIMEOUT_MS}ms`));
      }, ENCODER_METADATA_TIMEOUT_MS),
    };
    shared.metadataWaiters.add(waiter);
  });
}

function reserveInputRevision(shared: SharedEncoder): number {
  let revision = shared.nextInputRevision;
  while (shared.pendingCursorAcks.has(revision)) {
    revision = revision === Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
  }
  shared.nextInputRevision = revision === Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
  return revision;
}

function rememberCursorAck(shared: SharedEncoder, revision: number, ack: PendingCursorAck) {
  shared.pendingCursorAcks.set(revision, ack);
  if (shared.pendingCursorAcks.size <= MAX_PENDING_CURSOR_ACKS) return;
  const oldest = shared.pendingCursorAcks.keys().next().value as number | undefined;
  if (oldest !== undefined) shared.pendingCursorAcks.delete(oldest);
}

async function acquireSharedEncoder(
  windowID: string,
  binary: string,
  binaryMtimeMs: number,
  args: string[],
  codec: TileVideoCodec,
): Promise<SharedEncoder> {
  const identity = captureIdentity(args);
  const existing = sharedEncoders.get(windowID);
  // A rebuild retires the running child rather than joining it. The viewer pays one reconnect,
  // which is the cost the tile pool already accepts for the same reason, and in exchange an edit
  // to the helper is visible on the next offer instead of whenever the last viewer happens to
  // leave.
  if (existing && !existing.dead && existing.binaryMtimeMs !== binaryMtimeMs) {
    diag(`encoder key=${windowID} retired stale binary mtime=${existing.binaryMtimeMs} -> ${binaryMtimeMs}`);
    killSharedEncoder(existing, "stale-binary");
  }
  // A new capture size means a new child: the helper reads --width and --height once, at spawn.
  // The viewer pays one reconnect, the same trade the stale-binary retirement already makes.
  if (existing && !existing.dead && existing.identity !== identity) {
    diag(`encoder key=${windowID} retired capture change "${existing.identity}" -> "${identity}"`);
    killSharedEncoder(existing, "capture-args-changed");
  }
  if (existing && !existing.dead && existing.identity === identity && existing.binaryMtimeMs === binaryMtimeMs) {
    if (existing.codec !== codec) {
      throw new Error(`shared encoder codec changed from ${existing.codec} to ${codec}`);
    }
    diag(
      `encoder key=${windowID} reuse accessUnits=${existing.accessUnits} subscribers=${existing.subscribers.size} cachedKeyframe=${existing.latestKeyframe !== null}`,
    );
    return existing;
  }

  // Never start a capture on top of one that is still dying; see `encoderTeardowns`.
  await drainEncoderTeardowns();
  // Another offer may have created this encoder while we waited, and a second child for the same
  // key would orphan the first.
  const raced = sharedEncoders.get(windowID);
  if (raced && !raced.dead && raced.identity === identity && raced.binaryMtimeMs === binaryMtimeMs && raced.codec === codec) {
    diag(`encoder key=${windowID} adopted after teardown drain subscribers=${raced.subscribers.size}`);
    return raced;
  }
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  const videoDiagnostics = new WebrtcEncoderDiagnostics(windowID);
  const spawnedSize = captureSize(args);
  const shared: SharedEncoder = {
    key: windowID,
    identity,
    captureWidth: spawnedSize.width,
    captureHeight: spawnedSize.height,
    binaryMtimeMs,
    codec,
    child,
    subscribers: new Set(),
    latestKeyframe: null,
    accessUnits: 0,
    lastAccessUnitAtMs: null,
    firstAccessUnitDeadline: null,
    linger: null,
    dead: false,
    controlEvents: new WebrtcDesktopControlEvents(),
    sourceMetadata: null,
    metadataWaiters: new Set(),
    nextInputRevision: 1,
    pendingCursorAcks: new Map(),
    videoDiagnostics,
    videoDiagnosticsTimer: setInterval(() => videoDiagnostics.flush(), 10_000),
  };
  sharedEncoders.set(windowID, shared);
  diag(`encoder key=${windowID} spawn pid=${child.pid}`);
  shared.firstAccessUnitDeadline = setTimeout(() => {
    killSharedEncoder(shared, "first-access-unit-timeout");
  }, FIRST_ACCESS_UNIT_TIMEOUT_MS);

  void child.exited.then((status) => killSharedEncoder(shared, `process-exit-${status}`));
  void (async () => {
    let stopReason = "stdout-ended";
    try {
      for await (const frame of frames(child.stdout as ReadableStream<Uint8Array>)) {
        if (shared.dead) break;
        if (frame.kind === KIND_META) {
          const meta = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
          diag(`encoder key=${windowID} meta=${JSON.stringify(meta)}`);
          if (meta.type === "error") {
            stopReason = `encoder-error-${String(meta.message)}`;
            break;
          }
          if (meta.type === "resized") {
            // The child confirming a size it actually applied, so this is answerable from the log
            // rather than inferred from spawn arguments that never change.
            diag(`encoder key=${windowID} resized ${String(meta.width)}x${String(meta.height)}`);
            continue;
          }
          if (meta.type === "open") {
            const metadata = gridEncoderSourceMetadata(meta);
            if (!metadata) {
              stopReason = "invalid-open-metadata";
              break;
            }
            publishEncoderMetadata(shared, metadata);
          }
          continue;
        }
        if (frame.kind === KIND_CONTROL) {
          const event = shared.controlEvents.accept(frame.payload);
          if (event) {
            if (event.type === "desktop-unavailable") {
              diag(`encoder key=${shared.key} navigation-unavailable reason=${event.reason}`);
            }
            if (event.type === "cursor-applied") {
              const pending = shared.pendingCursorAcks.get(event.revision);
              shared.pendingCursorAcks.delete(event.revision);
              for (const subscriber of shared.subscribers) {
                if (pending?.inputOwner === subscriber.inputOwner) {
                  subscriber.onControl({ ...event, revision: pending.clientRevision });
                } else {
                  subscriber.onControl({ type: "cursor-position", x: event.x, y: event.y });
                }
              }
            } else if (event.type === "cursor-image" || event.type === "cursor-position"
                || event.type === "desktop-state" || event.type === "desktop-unavailable") {
              for (const subscriber of shared.subscribers) subscriber.onControl(event);
            } else {
              const owner = [...shared.subscribers].find(
                (subscriber) => subscriber.inputOwner === controlOwnership.owner,
              );
              owner?.onControl(event);
            }
          }
          continue;
        }
        if (frame.kind !== KIND_ACCESS_UNIT || frame.payload.length < 10) continue;
        shared.accessUnits += 1;
        shared.lastAccessUnitAtMs = Date.now();
        const isKeyframe = frame.payload[8] === 1;
        shared.videoDiagnostics.recordAccessUnit(frame.payload.length, isKeyframe);
        if (isKeyframe) shared.latestKeyframe = frame.payload;
        if (shared.accessUnits === 1) {
          if (shared.firstAccessUnitDeadline) {
            clearTimeout(shared.firstAccessUnitDeadline);
            shared.firstAccessUnitDeadline = null;
          }
          diag(
            `encoder key=${windowID} first-access-unit bytes=${frame.payload.length} keyframe=${frame.payload[8] === 1}`,
          );
        }
        for (const subscriber of shared.subscribers) subscriber.onAccessUnit(frame.payload);
      }
    } catch (error) {
      stopReason = `reader-error-${error instanceof Error ? error.message : String(error)}`;
    } finally {
      killSharedEncoder(shared, stopReason);
    }
  })();
  return shared;
}

function subscribeSharedEncoder(shared: SharedEncoder, subscriber: EncoderSubscriber): () => void {
  if (shared.linger) {
    clearTimeout(shared.linger);
    shared.linger = null;
  }
  shared.subscribers.add(subscriber);
  diag(`encoder key=${shared.key} subscribe subscribers=${shared.subscribers.size}`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    shared.subscribers.delete(subscriber);
    diag(`encoder key=${shared.key} release subscribers=${shared.subscribers.size}`);
    if (shared.subscribers.size === 0 && !shared.dead && !shared.linger) {
      shared.linger = setTimeout(() => {
        if (shared.subscribers.size === 0) killSharedEncoder(shared, "linger-expired");
      }, ENCODER_LINGER_MS);
    }
  };
}

function primeSubscriber(shared: SharedEncoder, subscriber: EncoderSubscriber) {
  if (shared.latestKeyframe) {
    diag(`encoder key=${shared.key} replay-keyframe bytes=${shared.latestKeyframe.length}`);
    subscriber.onAccessUnit(shared.latestKeyframe);
  } else {
    diag(`encoder key=${shared.key} request-keyframe no-cache`);
  }
  // Refresh the cache on the next capture callback. A static display may not
  // produce one, which is why replaying the retained keyframe above is the
  // joining viewer's authoritative bootstrap.
  shared.videoDiagnostics.recordKeyframeRequest("bootstrap");
  encoderStdin(shared, `${JSON.stringify({ type: "keyframe" })}\n`);
}

interface TileOffer {
  displayId?: string;
  attempt?: string;
  sdp?: string;
  type?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
}

interface TileTelemetry {
  attempt?: unknown;
  phase?: unknown;
  detail?: unknown;
  elapsedMs?: unknown;
}

export interface WebrtcDeliveryServerSample {
  sentRtpPackets: number;
  sentRtpBytes: number;
  retransmittedPacketsSent: number;
  retransmittedBytesSent: number;
  nackPacketsRequested: number;
  nackCacheHits: number;
  nackCacheMisses: number;
}

export interface WebrtcDeliveryClientSample {
  sample: number;
  elapsedMs: number;
  pair: string | null;
  pathState: string | null;
  rttMs: number | null;
  candidateBytesReceived: number;
  candidateBytesSent: number;
  inboundRtpPackets: number;
  inboundRtpBytes: number;
}

type DeliverySamplePair = {
  server: WebrtcDeliveryServerSample;
  client: WebrtcDeliveryClientSample;
};

const DELIVERY_CORRELATION_MIN_INTERVAL_MS = 900;

/**
 * Aligns browser receiver counters with the sender counters sampled when that
 * report reaches the sidecar. The backlog is deliberately labelled an estimate:
 * browser packetsReceived counts accepted media packets while sender repair
 * writes can duplicate a packet already received, so only sustained movement is
 * meaningful. Pair changes and counter resets start a new baseline.
 */
export class WebrtcDeliveryDiagnostics {
  private previous: DeliverySamplePair | null = null;
  private estimatedPendingMediaPackets = 0;

  sample(server: WebrtcDeliveryServerSample, client: WebrtcDeliveryClientSample) {
    const previous = this.previous;
    if (previous && client.sample <= previous.client.sample) return null;
    if (
      previous
      && client.elapsedMs - previous.client.elapsedMs < DELIVERY_CORRELATION_MIN_INTERVAL_MS
    ) return null;

    const pairChanged = previous !== null && client.pair !== previous.client.pair;
    const counterReset = previous !== null && !pairChanged && (
      server.sentRtpPackets < previous.server.sentRtpPackets
      || server.sentRtpBytes < previous.server.sentRtpBytes
      || server.retransmittedPacketsSent < previous.server.retransmittedPacketsSent
      || server.retransmittedBytesSent < previous.server.retransmittedBytesSent
      || server.nackPacketsRequested < previous.server.nackPacketsRequested
      || server.nackCacheHits < previous.server.nackCacheHits
      || server.nackCacheMisses < previous.server.nackCacheMisses
      || client.inboundRtpPackets < previous.client.inboundRtpPackets
      || client.inboundRtpBytes < previous.client.inboundRtpBytes
      || client.candidateBytesReceived < previous.client.candidateBytesReceived
      || client.candidateBytesSent < previous.client.candidateBytesSent
    );
    this.previous = { server, client };

    if (!previous || pairChanged || counterReset) {
      this.estimatedPendingMediaPackets = 0;
      return {
        event: "baseline",
        sample: client.sample,
        pair: client.pair,
        pairChanged,
        counterReset,
        path: {
          state: client.pathState,
          rttMs: client.rttMs,
          bytesReceived: client.candidateBytesReceived,
          bytesSent: client.candidateBytesSent,
        },
        sender: {
          mediaPackets: server.sentRtpPackets,
          mediaBytes: server.sentRtpBytes,
          repairPackets: server.retransmittedPacketsSent,
          repairBytes: server.retransmittedBytesSent,
        },
        receiver: {
          mediaPackets: client.inboundRtpPackets,
          mediaBytes: client.inboundRtpBytes,
        },
        backlog: { estimatedPendingMediaPackets: 0 },
      };
    }

    const senderMediaPackets = server.sentRtpPackets - previous.server.sentRtpPackets;
    const senderMediaBytes = server.sentRtpBytes - previous.server.sentRtpBytes;
    const senderRepairPackets = server.retransmittedPacketsSent
      - previous.server.retransmittedPacketsSent;
    const senderRepairBytes = server.retransmittedBytesSent
      - previous.server.retransmittedBytesSent;
    const receiverMediaPackets = client.inboundRtpPackets - previous.client.inboundRtpPackets;
    const receiverMediaBytes = client.inboundRtpBytes - previous.client.inboundRtpBytes;
    const backlogPacketDelta = senderMediaPackets - receiverMediaPackets;
    const recoveredPendingMediaPackets = Math.min(
      this.estimatedPendingMediaPackets,
      Math.max(0, -backlogPacketDelta),
    );
    this.estimatedPendingMediaPackets = Math.max(
      0,
      this.estimatedPendingMediaPackets + backlogPacketDelta,
    );

    return {
      event: "sample",
      sample: client.sample,
      intervalMs: client.elapsedMs - previous.client.elapsedMs,
      pair: client.pair,
      pairChanged: false,
      counterReset: false,
      path: {
        state: client.pathState,
        rttMs: client.rttMs,
        bytesReceivedDelta: client.candidateBytesReceived
          - previous.client.candidateBytesReceived,
        bytesSentDelta: client.candidateBytesSent - previous.client.candidateBytesSent,
      },
      sender: {
        mediaPacketsDelta: senderMediaPackets,
        mediaBytesDelta: senderMediaBytes,
        repairPacketsDelta: senderRepairPackets,
        repairBytesDelta: senderRepairBytes,
        transportWritePacketsDelta: senderMediaPackets + senderRepairPackets,
        transportWriteBytesDelta: senderMediaBytes + senderRepairBytes,
      },
      receiver: {
        mediaPacketsDelta: receiverMediaPackets,
        mediaBytesDelta: receiverMediaBytes,
      },
      repair: {
        nackPacketsRequestedDelta: server.nackPacketsRequested
          - previous.server.nackPacketsRequested,
        cacheHitsDelta: server.nackCacheHits - previous.server.nackCacheHits,
        cacheMissesDelta: server.nackCacheMisses - previous.server.nackCacheMisses,
      },
      backlog: {
        packetDelta: backlogPacketDelta,
        recoveredPendingMediaPackets,
        estimatedPendingMediaPackets: this.estimatedPendingMediaPackets,
      },
    };
  }
}

function nonnegativeCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export function parseWebrtcDeliveryClientSample(
  detail: unknown,
  elapsedMs: unknown,
): WebrtcDeliveryClientSample | null {
  if (typeof detail !== "string" || detail.length > 8_192) return null;
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const report = value as Record<string, unknown>;
  const inbound = report.inbound;
  const path = report.path;
  if (
    typeof inbound !== "object"
    || inbound === null
    || typeof path !== "object"
    || path === null
  ) return null;
  const inboundStats = inbound as Record<string, unknown>;
  const pathStats = path as Record<string, unknown>;
  const sample = nonnegativeCounter(report.sample);
  const atMs = nonnegativeCounter(elapsedMs);
  const inboundRtpPackets = nonnegativeCounter(inboundStats.packets);
  const inboundRtpBytes = nonnegativeCounter(inboundStats.bytes);
  const candidateBytesReceived = nonnegativeCounter(pathStats.bytesReceived);
  const candidateBytesSent = nonnegativeCounter(pathStats.bytesSent);
  if (
    sample === null
    || sample < 1
    || atMs === null
    || inboundRtpPackets === null
    || inboundRtpBytes === null
    || candidateBytesReceived === null
    || candidateBytesSent === null
  ) return null;
  return {
    sample,
    elapsedMs: atMs,
    pair: typeof pathStats.pair === "string" ? pathStats.pair : null,
    pathState: typeof pathStats.state === "string" ? pathStats.state : null,
    rttMs: nonnegativeCounter(pathStats.rttMs),
    candidateBytesReceived,
    candidateBytesSent,
    inboundRtpPackets,
    inboundRtpBytes,
  };
}

interface ConnectionDiagnostic {
  attempt: string;
  connection: number;
  windowID: string;
  createdAtMs: number;
  closedAtMs: number | null;
  iceState: string;
  connectionState: string;
  transportReady: boolean;
  sentAccessUnits: number;
  sentRtpPackets: number;
  sentRtpBytes: number;
  lastSentAtMs: number | null;
  disconnectedAtMs: number | null;
  senderRepairStats: () => RTCRtpHistoryRepairStats;
  deliveryDiagnostics: WebrtcDeliveryDiagnostics;
  pliRequests: number;
  encoder: SharedEncoder | null;
}

const connectionDiagnostics = new Map<string, ConnectionDiagnostic>();
const CONNECTION_DIAGNOSTIC_TTL_MS = 120_000;
const CONNECTION_DIAGNOSTIC_LIMIT = 64;

function pruneConnectionDiagnostics(nowMs = Date.now()) {
  for (const [attempt, connection] of connectionDiagnostics) {
    if (
      connection.closedAtMs !== null
      && nowMs - connection.closedAtMs > CONNECTION_DIAGNOSTIC_TTL_MS
    ) connectionDiagnostics.delete(attempt);
  }
  while (connectionDiagnostics.size > CONNECTION_DIAGNOSTIC_LIMIT) {
    const oldestClosed = [...connectionDiagnostics.entries()]
      .find(([, connection]) => connection.closedAtMs !== null);
    const oldest = oldestClosed ?? connectionDiagnostics.entries().next().value;
    if (!oldest) break;
    connectionDiagnostics.delete(oldest[0]);
  }
}

function serverConnectionSnapshot(attempt: string, nowMs = Date.now()): string | null {
  const connection = connectionDiagnostics.get(attempt);
  if (!connection) return null;
  const encoder = connection.encoder;
  const repair = connection.senderRepairStats();
  return `server-snapshot ${JSON.stringify({
    attempt,
    connection: connection.connection,
    windowID: connection.windowID,
    ageMs: nowMs - connection.createdAtMs,
    ice: connection.iceState,
    state: connection.connectionState,
    transportReady: connection.transportReady,
    sentAccessUnits: connection.sentAccessUnits,
    sentRtpPackets: connection.sentRtpPackets,
    sentRtpBytes: connection.sentRtpBytes,
    lastSentAgeMs: connection.lastSentAtMs === null ? -1 : nowMs - connection.lastSentAtMs,
    disconnectedAgeMs: connection.disconnectedAtMs === null
      ? -1
      : nowMs - connection.disconnectedAtMs,
    nackReports: repair.nackReports,
    nackPacketsRequested: repair.packetsRequested,
    nackCacheHits: repair.cacheHits,
    nackCacheMisses: repair.cacheMisses,
    retransmittedPacketsSent: repair.retransmittedPacketsSent,
    retransmittedBytesSent: repair.retransmittedBytesSent,
    retransmissionQueueDepth: repair.queueDepth,
    retransmissionQueueHighWaterMark: repair.queueHighWaterMark,
    retransmissionQueueBusyAgeMs: repair.queueBusyAgeMs,
    retransmissionSendFailures: repair.sendFailures,
    pliRequests: connection.pliRequests,
    encoderAccessUnits: encoder?.accessUnits,
    encoderLastAccessUnitAgeMs: !encoder || encoder.lastAccessUnitAtMs === null
      ? -1
      : nowMs - encoder.lastAccessUnitAtMs,
    encoderSubscribers: encoder?.subscribers.size,
    encoderDead: encoder?.dead,
  })}`;
}

function serverDeliverySample(connection: ConnectionDiagnostic): WebrtcDeliveryServerSample {
  const repair = connection.senderRepairStats();
  return {
    sentRtpPackets: connection.sentRtpPackets,
    sentRtpBytes: connection.sentRtpBytes,
    retransmittedPacketsSent: repair.retransmittedPacketsSent,
    retransmittedBytesSent: repair.retransmittedBytesSent,
    nackPacketsRequested: repair.packetsRequested,
    nackCacheHits: repair.cacheHits,
    nackCacheMisses: repair.cacheMisses,
  };
}

const CLIENT_PHASES = new Set([
  "answer-received",
  "answer-applied",
  "ice-state",
  "connection-state",
  "track-received",
  "play-rejected",
  "first-frame",
  "video-presentation",
  "presentation-gap",
  "receiver-stats",
  "receiver-stats-error",
  "control-channel-state",
  "control-ownership",
  "keyboard-state",
  "keyboard-focus-result",
  "keyboard-input-applied",
  "keyboard-input-rejected",
  "keyboard-buffer-overflow",
  "navigation-rejected",
  "navigation-gesture",
  "navigation-settled",
  "navigation-select",
  "navigation-display",
  "setup-timeout",
  "first-frame-timeout",
  "viewport-gesture-start",
  "viewport-gesture-end",
]);

function recordClientTelemetry(
  windowID: string,
  body: TileTelemetry,
  recordDiagnostic: (line: string) => void,
): Response {
  if (
    typeof body.attempt !== "string"
    || !/^[a-zA-Z0-9-]{1,80}$/.test(body.attempt)
    || typeof body.phase !== "string"
    || !CLIENT_PHASES.has(body.phase)
  ) {
    return jsonResponse(
      { code: "webrtc-bad-telemetry", message: "invalid attempt or phase" },
      400,
    );
  }
  const detail = typeof body.detail === "string" ? body.detail.slice(0, 2_048) : undefined;
  const elapsedMs = bounded(body.elapsedMs, 0, 604_800_000);
  recordDiagnostic(
    `client ${JSON.stringify({
      windowID,
      attempt: body.attempt,
      phase: body.phase,
      detail,
      elapsedMs,
    })}`,
  );
  const connection = connectionDiagnostics.get(body.attempt);
  if (connection && (body.phase === "receiver-stats" || body.phase === "presentation-gap")) {
    const clientSample = parseWebrtcDeliveryClientSample(body.detail, elapsedMs);
    if (clientSample) {
      const correlation = connection.deliveryDiagnostics.sample(
        serverDeliverySample(connection),
        clientSample,
      );
      if (correlation) {
        recordDiagnostic(`delivery-correlation ${JSON.stringify({
          attempt: body.attempt,
          connection: connection.connection,
          windowID,
          ...correlation,
        })}`);
      }
    }
  }
  if (
    body.phase === "receiver-stats"
    || body.phase === "presentation-gap"
    || body.phase === "ice-state"
    || body.phase === "connection-state"
  ) {
    const snapshot = serverConnectionSnapshot(body.attempt);
    if (snapshot) recordDiagnostic(snapshot);
  }
  pruneConnectionDiagnostics();
  return new Response(null, { status: 204 });
}

function bounded(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? Math.round(value) : undefined;
}

/**
 * A capture parameter, held inside the range the helper accepts.
 *
 * Asking for more than the maximum is asking for the maximum, not asking for nothing. These were
 * validated with `bounded`, which drops an out-of-range number, and dropping one is not neutral:
 * omit `--width` and the helper captures the display at its native size while the bitrate in the
 * same offer still describes the smaller picture that was requested. Raising the resolution far
 * enough therefore stopped raising it and quietly made the image worse instead.
 */
function clampedCaptureParameter(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(max, Math.max(min, value)));
}

async function answer(windowID: string, offer: TileOffer, signal: AbortSignal): Promise<Response> {
  const { path: binary, mtimeMs: binaryMtimeMs, exists } = helperBinary();
  if (!exists) {
    return jsonResponse(
      { code: "tile-encoder-missing", message: missingHelperMessage(binary) },
      503,
    );
  }
  if (!offer.sdp || offer.type !== "offer") {
    return jsonResponse({ code: "webrtc-bad-offer", message: "body must carry an SDP offer" }, 400);
  }
  if (offer.displayId !== undefined && (windowID !== "display" || !desktopDisplayId(offer.displayId))) {
    return jsonResponse({ code: "webrtc-bad-offer", message: "invalid display selection" }, 400);
  }
  let captureKey = windowID;
  let captureId: number | undefined;
  let captureDisplayId: string | undefined;
  if (windowID === "display") {
    try {
      const target = await resolveDisplayTarget(offer.displayId, () => controlHelper.request("desktop-displays"));
      captureKey = target.key;
      captureId = target.captureId;
      captureDisplayId = target.displayId;
    } catch (error) {
      const code = error instanceof DisplayTargetUnavailable ? error.code : "navigation-unavailable";
      return jsonResponse({ code, message: code,
        ...(error instanceof DisplayTargetUnavailable && error.replacementDisplayId
          ? { replacementDisplayId: error.replacementDisplayId } : {}) }, 409);
    }
  }
  if (
    offer.attempt !== undefined
    && !/^[a-zA-Z0-9-]{1,80}$/.test(offer.attempt)
  ) {
    return jsonResponse({ code: "webrtc-bad-offer", message: "attempt was invalid" }, 400);
  }

  if (signal.aborted) return jsonResponse({ code: "offer-cancelled" }, 499);
  const tailnet = tailnetIPv4();
  const peer = new RTCPeerConnection({
    codecs: { video: [H265, H264] },
    iceAdditionalHostAddresses: tailnet ? [tailnet] : undefined,
    rtpHistorySize: config.webrtcRtpHistoryPackets,
  });
  const track = new MediaStreamTrack({ kind: "video" });
  const transceiver = peer.addTransceiver(track, { direction: "sendonly" });
  const connection = ++diagSequence;
  const attempt = offer.attempt ?? `server-c${connection}`;
  const connectionDiagnostic: ConnectionDiagnostic = {
    attempt,
    connection,
    windowID,
    createdAtMs: Date.now(),
    closedAtMs: null,
    iceState: "new",
    connectionState: "new",
    transportReady: false,
    sentAccessUnits: 0,
    sentRtpPackets: 0,
    sentRtpBytes: 0,
    lastSentAtMs: null,
    disconnectedAtMs: null,
    senderRepairStats: () => transceiver.sender.rtpHistoryRepairStats,
    deliveryDiagnostics: new WebrtcDeliveryDiagnostics(),
    pliRequests: 0,
    encoder: null,
  };
  connectionDiagnostics.set(attempt, connectionDiagnostic);
  pruneConnectionDiagnostics();
  const closeConnectionDiagnostic = () => {
    if (connectionDiagnostic.closedAtMs === null) connectionDiagnostic.closedAtMs = Date.now();
    connectionDiagnostic.transportReady = false;
    connectionDiagnostic.disconnectedAtMs = null;
  };
  let inputEncoder: SharedEncoder | null = null;
  let cursorChannel: RTCDataChannel | null = null;
  const inputOwner = Symbol(`control-c${connection}`);
  let controlMessages = 0;
  let rejectedControlMessages = 0;
  const releaseInputOwner = () => {
    const encoder = inputEncoder;
    if (!encoder) return;
    for (const [revision, pending] of encoder.pendingCursorAcks) {
      if (pending.inputOwner === inputOwner) encoder.pendingCursorAcks.delete(revision);
    }
    controlOwners.delete(inputOwner);
    const released = controlOwnership.release(inputOwner);
    if (!released.changed) return;
    encoderStdin(encoder, desktopControlLine({ type: "release-control" }));
    sendControl({ type: "control-revoked", epoch: released.epoch });
    diag(`c${connection} control released messages=${controlMessages} epoch=${released.epoch}`);
  };
  const sendControl = (event: DesktopControlEvent) => {
    if (cursorChannel?.readyState !== "open") return;
    cursorChannel.send(JSON.stringify(event));
  };
  const currentControlChannel = () => cursorChannel;
  const rejectControl = (
    reason: "helper-unavailable" | "malformed" | "not-owner" | "oversized",
  ) => {
    sendControl({ type: "input-rejected", reason });
  };
  const acquireInputOwner = (encoder: SharedEncoder) => {
    const acquired = controlOwnership.acquire(inputOwner);
    if (!acquired.changed) return;
    const previousOwner = acquired.previous ? controlOwners.get(acquired.previous) : undefined;
    if (previousOwner) {
      encoderStdin(previousOwner.encoder, desktopControlLine({ type: "release-control" }));
      previousOwner.revoke(acquired.epoch);
    }
    encoderStdin(encoder, desktopControlLine({ type: "release-control" }));
    controlOwners.set(inputOwner, { encoder, revoke: (epoch) => {
      for (const [revision, pending] of encoder.pendingCursorAcks) {
        if (pending.inputOwner === inputOwner) encoder.pendingCursorAcks.delete(revision);
      }
      sendControl({ type: "control-revoked", epoch });
    } });
    sendControl({ type: "control-granted", epoch: acquired.epoch });
    diag(`c${connection} control acquired encoder=${encoder.key} epoch=${acquired.epoch}`);
  };
  peer.onDataChannel.subscribe((channel) => {
    if (channel.label !== "agentdesk-control-v2") {
      diag(`c${connection} rejected data-channel label=${channel.label}`);
      channel.close();
      return;
    }
    cursorChannel = channel;
    diag(`c${connection} control channel received`);
    channel.onMessage.subscribe((data) => {
      const input = desktopControlInput(data);
      if (!input) {
        rejectedControlMessages += 1;
        const reason = desktopControlRejectionReason(data);
        rejectControl(reason);
        if (rejectedControlMessages === 1) {
          diag(`c${connection} rejected first control message reason=${reason}`);
        }
        return;
      }
      if (!inputEncoder || inputEncoder.dead) {
        rejectedControlMessages += 1;
        rejectControl("helper-unavailable");
        return;
      }
      if (input.type === "space-select" || input.type === "space-gesture") {
        if (input.displayId !== captureDisplayId || inputEncoder.sourceMetadata?.desktopNavigationVersion !== 1) {
          sendControl({ type: "space-result", requestId: input.type === "space-select" ? input.requestId : input.gestureId,
            status: "rejected", reason: "display-unavailable" });
          return;
        }
      }
      if (captureDisplayId && input.type !== "desktop-refresh" && input.type !== "release-control"
          && inputEncoder.controlEvents.captureDisplayMissing(captureDisplayId)) {
        sendControl({ type: "desktop-unavailable", reason: "display-unavailable" });
        return;
      }
      if (input.type === "desktop-refresh" && !captureDisplayId) {
        sendControl({ type: "desktop-unavailable", reason: "navigation-unavailable" });
        return;
      }
      if (input.type === "configure" || input.type === "desktop-refresh") {
        encoderStdin(inputEncoder, desktopControlLine(input));
        return;
      }
      if (input.type === "release-control") {
        if (controlOwnership.owner !== inputOwner) {
          rejectControl("not-owner");
          return;
        }
        releaseInputOwner();
        return;
      }
      if (input.type === "space-gesture" && input.phase !== "began"
          && controlOwnership.owner !== inputOwner) {
        sendControl({ type: "space-result", requestId: input.gestureId, status: "rejected", reason: "not-owner" });
        return;
      }
      acquireInputOwner(inputEncoder);
      controlMessages += 1;
      if (input.type === "pointer-move") {
        const nativeRevision = reserveInputRevision(inputEncoder);
        rememberCursorAck(inputEncoder, nativeRevision, {
          inputOwner,
          clientRevision: input.revision,
        });
        const nativeInput: DesktopControlInput = { ...input, revision: nativeRevision };
        encoderStdin(inputEncoder, desktopControlLine(nativeInput));
      } else {
        encoderStdin(inputEncoder, desktopControlLine(input));
      }
    });
    channel.stateChange.subscribe((state) => {
      diag(`c${connection} control channel=${state}`);
      if (state === "open" && inputEncoder) {
        for (const event of inputEncoder.controlEvents.snapshot()) sendControl(event);
      }
      if (state === "closed") releaseInputOwner();
    });
  });
  diag(`c${connection} window=${windowID} offer candidates: ${candidateLines(offer.sdp).join(" | ") || "NONE"}`);

  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  diag(`c${connection} offered-codecs=${transceiver.codecs.map(
    (codec) => `${codec.mimeType}:${codec.payloadType}:${codec.parameters ?? ""}`,
  ).join(" | ")}`);
  const activeCodec = sharedEncoders.get(captureKey)?.codec;
  let choice = chooseTileVideoCodec(transceiver.codecs, activeCodec);
  if (!choice) {
    closeConnectionDiagnostic();
    void peer.close();
    return jsonResponse({
      code: "webrtc-codec-unavailable",
      message: activeCodec
        ? `browser did not offer the active ${activeCodec} shared-stream codec`
        : "browser did not offer supported H.265 SRST or H.264 packetization-mode=1",
    }, 415);
  }
  transceiver.sender.codec = choice.negotiated;
  track.codec = choice.negotiated;

  const local = await peer.createAnswer();
  await peer.setLocalDescription(local);
  if (signal.aborted) {
    closeConnectionDiagnostic();
    void peer.close();
    return jsonResponse({ code: "offer-cancelled" }, 499);
  }
  diag(`c${connection} answer candidates: ${candidateLines(peer.localDescription!.sdp).join(" | ") || "NONE"}`);
  peer.iceConnectionStateChange.subscribe((state) => {
    connectionDiagnostic.iceState = state;
    diag(`c${connection} ice=${state}`);
  });

  // Another offer can finish while certificates and ICE are being prepared.
  // Re-check synchronously before acquiring so both connections cannot create
  // different codecs for the one-window/one-capture authority.
  const nowActiveCodec = sharedEncoders.get(captureKey)?.codec;
  if (nowActiveCodec && nowActiveCodec !== choice.kind) {
    const activeChoice = chooseTileVideoCodec(transceiver.codecs, nowActiveCodec);
    if (!activeChoice) {
      closeConnectionDiagnostic();
      void peer.close();
      return jsonResponse({
        code: "webrtc-codec-unavailable",
        message: `browser did not offer the active ${nowActiveCodec} shared-stream codec`,
      }, 415);
    }
    choice = activeChoice;
    transceiver.sender.codec = choice.negotiated;
    track.codec = choice.negotiated;
  }

  const profile = choice.h264Profile ?? "main";
  diag(`c${connection} codec=${choice.kind} pt=${choice.negotiated.payloadType} profile=${profile} size=${offer.width}x${offer.height} bitrate=${offer.bitrate} rtpHistoryPackets=${config.webrtcRtpHistoryPackets}`);

  const args = [
    ...(windowID === "display" ? ["--display", String(captureId)] : ["--window", windowID]),
    "--codec", choice.kind === "h265" ? "h265-annexb" : "h264-annexb",
    // RTP has no segment boundary to satisfy. A joining viewer receives the
    // retained bootstrap and requests a fresh keyframe; loss recovery does the
    // same through PLI. VideoToolbox's low-latency mode keeps that GOP infinite,
    // because periodic keyframes only create unrequested LTE bursts.
  ];
  if (choice.kind === "h264") args.push("--profile", profile);
  const width = clampedCaptureParameter(offer.width, 16, 7680);
  const height = clampedCaptureParameter(offer.height, 16, 4320);
  const fps = clampedCaptureParameter(offer.fps, 1, 60);
  const bitrate = clampedCaptureParameter(offer.bitrate, 100_000, 40_000_000);
  if (width) args.push("--width", String(width));
  if (height) args.push("--height", String(height));
  if (fps) args.push("--fps", String(fps));
  if (bitrate) args.push("--bitrate", String(bitrate));

  // One retry, because a wedged capture is recoverable and a viewer switching monitors is not
  // patient. Draining teardowns before a spawn makes the starve rare, but ScreenCaptureKit can
  // still hand back a stream that never produces a frame; the helper only reports that by dying,
  // and by then the offer is already lost. A second attempt starts from a settled machine, so it
  // either works or fails for a reason worth surfacing.
  let shared!: SharedEncoder;
  let source!: WebrtcTileSourceMetadata;
  for (let attempt = 1; ; attempt += 1) {
    shared = await acquireSharedEncoder(captureKey, binary, binaryMtimeMs, args, choice.kind);
    inputEncoder = shared;
    connectionDiagnostic.encoder = shared;
    try {
      source = await waitForEncoderMetadata(shared);
      if (captureDisplayId && source.displayId !== captureDisplayId) {
        throw new Error("capture display identity does not match the requested monitor");
      }
      break;
    } catch (error) {
      killSharedEncoder(shared, "source-metadata-unavailable");
      // Only a capture that never spoke is worth starting again. A display that answered with the
      // wrong identity, or a cancelled offer, would fail the same way twice.
      const retryable = attempt === 1 && !signal.aborted && !(error instanceof Error
        && error.message.startsWith("capture display identity"));
      if (!retryable) {
        closeConnectionDiagnostic();
        void peer.close();
        throw error;
      }
      diag(`c${connection} encoder key=${captureKey} retrying after ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let dead = false;
  let release: () => void = () => {};
  const shutdown = (reason: string) => {
    if (dead) return;
    dead = true;
    closeConnectionDiagnostic();
    diag(`c${connection} shutdown reason=${reason}`);
    releaseInputOwner();
    release();
    void peer.close();
  };

  // NACK is the delta-preserving repair path. The patched sender owns exact
  // cache hit, miss, pending-send, high-water, and failure counters; snapshots
  // read them synchronously so telemetry never polls or races an async stats refresh.
  transceiver.sender.onPictureLossIndication.subscribe(() => {
    connectionDiagnostic.pliRequests += 1;
    shared.videoDiagnostics.recordKeyframeRequest("pli");
    encoderStdin(shared, `${JSON.stringify({ type: "keyframe" })}\n`);
  });
  // The receiver's bandwidth estimate drives the encoder's bitrate, which
  // retires the last hand-set number in this path: the page's request is only
  // the seed until the first REMB lands. With several viewers the last
  // estimate wins, which slightly favours whoever spoke most recently; the
  // honest multi-viewer answer (minimum across viewers) can land with the
  // grid. Updates under a tenth of the last applied value are noise and
  // skipped.
  let appliedBitrate = 0;
  /**
   * The most this picture is worth spending, from its own pixel count rather than a fixed number.
   *
   * A flat 20 Mbit ceiling was set when a capture meant roughly a 1080p screen. It is a third of a
   * bit per pixel there, and four hundredths of one across an 8K desktop -- far below what H.265
   * needs to keep text legible, so raising the resolution made the picture worse and no amount of
   * available bandwidth was allowed to help. The estimator still decides what the link can carry;
   * this only stops the ceiling from being the binding constraint on a large capture.
   */
  const bitrateCeiling = () => {
    const pixels = (shared.captureWidth ?? 1_920) * (shared.captureHeight ?? 1_080);
    const wanted = pixels * (fps || 15) * TARGET_BITS_PER_PIXEL;
    return Math.round(Math.max(20_000_000, Math.min(120_000_000, wanted)));
  };
  const applyEstimate = (estimate: number) => {
    if (!Number.isFinite(estimate) || estimate <= 0) return;
    // The floor matters more than it looks: a quiet window sends almost
    // nothing, REMB can only estimate what it measures, so quiet-time
    // estimates read tens of kilobits. That is absence of evidence, not a bad
    // link, and obeying it would start every burst of motion at slideshow
    // quality. From the floor, GCC's multiplicative ramp recovers the real
    // capacity within seconds of traffic flowing.
    const clamped = Math.max(300_000, Math.min(bitrateCeiling(), Math.round(estimate)));
    if (appliedBitrate > 0 && Math.abs(clamped - appliedBitrate) / appliedBitrate < 0.1) return;
    const previous = appliedBitrate;
    appliedBitrate = clamped;
    encoderStdin(shared, `${JSON.stringify({ type: "bitrate", bits: clamped })}\n`);
    // A raised budget does not improve a picture that has stopped changing.
    //
    // The GOP is infinite, so the last keyframe is what a still desktop is made of, and the
    // estimator can only measure traffic that exists: an idle screen sends almost nothing, the
    // estimate falls to the floor, and whatever keyframe was encoded in that window becomes the
    // image indefinitely. Deltas cannot repair it, because nothing is moving to carry them. When
    // the budget recovers, the picture has to be asked for again to benefit -- otherwise quality
    // improves only by the accident of someone dragging a window.
    if (previous > 0 && clamped >= previous * KEYFRAME_ON_RECOVERY_FACTOR) {
      diag(`c${connection} keyframe-on-recovery ${previous} -> ${clamped}`);
      shared.videoDiagnostics.recordKeyframeRequest("bitrate-recovery");
      encoderStdin(shared, `${JSON.stringify({ type: "keyframe" })}\n`);
    }
  };
  transceiver.sender.onRtcp.subscribe((rtcp) => {
    const feedback = (rtcp as { feedback?: { bitrate?: bigint } }).feedback;
    if (feedback && typeof feedback.bitrate === "bigint") applyEstimate(Number(feedback.bitrate));
  });

  // Feed: packetize each shared access unit into this connection's track.
  // werift rewrites SSRC and payload type to the negotiated values; sequence
  // numbers and the 90kHz timestamp are ours to keep monotonic per connection.
  const randomStart = crypto.getRandomValues(new Uint32Array(2));
  let sequence = randomStart[0]! & 0xffff;
  const timestampOffset = randomStart[1]!;
  let sentAccessUnits = 0;
  let transportReady = false;
  const subscriber: EncoderSubscriber = {
    inputOwner,
    onAccessUnit: (payload) => {
      if (dead || !transportReady) return;
      sentAccessUnits += 1;
      connectionDiagnostic.sentAccessUnits = sentAccessUnits;
      if (sentAccessUnits === 1) {
        diag(`c${connection} first-access-unit bytes=${payload.length} keyframe=${payload[8] === 1}`);
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const ptsMicros = view.getBigUint64(0);
      const timestamp = Number((BigInt(timestampOffset) + ((ptsMicros * 9n) / 100n)) & 0xffff_ffffn);
      const accessUnit = payload.subarray(9);
      const rtpPayloads = choice.kind === "h265"
        ? packetizeH265(accessUnit)
        : packetizeH264(accessUnit);
      for (const { payload: rtpPayload, last } of rtpPayloads) {
        const packet = new RtpPacket(
          new RtpHeader({
            sequenceNumber: sequence,
            timestamp,
            marker: last,
            payloadType: 96,
            ssrc: 0,
          }),
          Buffer.from(rtpPayload),
        );
        sequence = (sequence + 1) % 0x10000;
        track.writeRtp(packet);
        connectionDiagnostic.sentRtpPackets += 1;
        connectionDiagnostic.sentRtpBytes += rtpPayload.length;
        connectionDiagnostic.lastSentAtMs = Date.now();
      }
    },
    onControl: sendControl,
    onDead: () => shutdown("encoder-dead"),
  };
  release = subscribeSharedEncoder(shared, subscriber);
  if (signal.aborted) {
    shutdown("offer-cancelled");
    return jsonResponse({ code: "offer-cancelled" }, 499);
  }
  if (currentControlChannel()?.readyState === "open") {
    for (const event of shared.controlEvents.snapshot()) sendControl(event);
  }

  // The transport reports peer death (ICE consent, DTLS close); that report is
  // this subscription's whole lifecycle. Bootstrap only after DTLS is ready so
  // the retained keyframe cannot be written before the peer can receive RTP.
  peer.connectionStateChange.subscribe((state) => {
    connectionDiagnostic.connectionState = state;
    diag(`c${connection} connection=${state}`);
    if (state === "disconnected") {
      if (connectionDiagnostic.disconnectedAtMs === null) {
        connectionDiagnostic.disconnectedAtMs = Date.now();
        diag(`c${connection} transient-disconnect awaiting ICE recovery`);
      }
      return;
    }
    if (state === "connected" && !transportReady) {
      transportReady = true;
      connectionDiagnostic.transportReady = true;
      primeSubscriber(shared, subscriber);
    }
    if (state === "connected") {
      const disconnectedAtMs = connectionDiagnostic.disconnectedAtMs;
      if (disconnectedAtMs !== null) {
        connectionDiagnostic.disconnectedAtMs = null;
        diag(`c${connection} transient-disconnect recovered durationMs=${Date.now() - disconnectedAtMs}`);
      }
    }
    // `disconnected` is explicitly transient. The browser owns its eight-second
    // reconnect window, while werift's RFC 7675 consent lifecycle eventually
    // turns an unrecoverable path into `failed`. Closing earlier prevents both.
    if (isTerminalWebrtcConnectionState(state)) shutdown(`connection-${state}`);
  });

  // Vanilla ICE: werift resolves setLocalDescription after gathering, so the
  // answer already carries the host candidates and no trickle round-trips are
  // needed over the signaling channel.
  const response: WebrtcTileAnswer = {
    type: "answer",
    sdp: peer.localDescription!.sdp,
    codec: choice.kind,
    source,
  };
  return jsonResponse(response);
}

export function createWebrtcTileRoutes(
  recordClientDiagnostic: (line: string) => void = diag,
): RouteHandler {
  return (request, url) => {
    if (request.method !== "POST") return undefined;
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
