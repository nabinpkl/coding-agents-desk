// The pool of running grid-encoder children, one per capture stream.
//
// Two ScreenCaptureKit captures of one target starve each other, so this is the only place a
// capture is started, and the map is what makes a second viewer join the running one instead.
// Everything here is about a CHILD: spawning it behind whatever teardown is still draining,
// reading its framing, fanning its access units out to subscribers, and killing it.
//
// Which encoder a request belongs to is `webrtcEncoderIdentity.ts`; how the peer that subscribes
// is built is the route's own job.

import type {
  DesktopControlEvent,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { basename } from "node:path";
import { config } from "@/config/config";
import { acquireEncoderSlot } from "@/desktop/encoderSlots";
import { frames, KIND_META } from "@/http/tile/tile-encoder/encoderFrames";
import { WebrtcDesktopControlEvents } from "@/http/tile/tile-control/webrtcDesktopControlEvents";
import { DesktopControlOwnership } from "@/http/tile/tile-control/webrtcDesktopControlOwnership";
import { gridEncoderSourceMetadata } from "@/http/tile/tile-encoder/webrtcTileMetadata";
import type { TileVideoCodec } from "@/http/tile/tile-codec/webrtcTileCodec";
import { diag, WebrtcEncoderDiagnostics } from "@/http/tile/tile-diagnostics/webrtcDiagnosticsLog";
import {
  captureIdentity,
  encoderDisposition,
  encoderStreamKey,
  geometryTag,
} from "@/http/tile/tile-encoder/webrtcEncoderIdentity";

/** Kind 3 in the encoder framing: one Annex-B access unit. */
const KIND_ACCESS_UNIT = 3;
const KIND_CONTROL = 4;

/**
 * One encoder per capture STREAM: a target, and the pixels asked of it. Resolution is not part of
 * that -- see `encoderStreamKey` for where the line falls and why.
 *
 * Not an optimization: two ScreenCaptureKit captures of one target starve each other (measured on
 * the MSE path at 48ms apart, and measured again here when a reconnect overlapped the old
 * session's encoder, which outlives its dead peer by the ICE consent timeout, so BOTH captures sat
 * at zero frames). The viewer's overview and detail streams ask for different pixels and are worth
 * that cost; two viewers of the same pixels at different sizes are not. The first one's geometry
 * and profile win, and the later one's element scales the picture.
 */
export interface SharedEncoder {
  key: string;
  /**
   * The spawn arguments that decide what this child captures and at what size, minus the ones it
   * can be told to change while running. Only the crop reaches the key (`encoderStreamKey`);
   * carrying the resolution there too is what let two captures of one display coexist. The helper
   * takes --width and --height only at spawn, so a viewer wanting different ones can be served
   * only by a respawn: see `encoderDisposition` for when that is worth doing.
   */
  identity: string;
  /** A readable geometry for diagnostics, since the key no longer carries one. */
  geometry: string;
  /**
   * Installed stamp of the binary this child was spawned from. Reuse is keyed on the stream, so
   * without this an updated helper would be shadowed by the previous process for
   * as long as one viewer stayed connected, and `just grid-encoder-install` would look like it
   * had done nothing.
   */
  binaryMtimeMs: number;
  /** The slot copy this child runs from; see `acquireEncoderSlot`. */
  binary: string;
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

export interface EncoderSubscriber {
  inputOwner: symbol;
  /** One access-unit payload: 8 bytes pts-microseconds, 1 keyframe byte, Annex-B. */
  onAccessUnit: (payload: Uint8Array) => void;
  onControl: (event: DesktopControlEvent) => void;
  /** The encoder died; the connection has nothing left to send. */
  onDead: () => void;
}

export const sharedEncoders = new Map<string, SharedEncoder>();
/** Which child last ran from each slot copy; a slot is free again once that child has exited. */
const encoderSlotHolders = new Map<string, ReturnType<typeof Bun.spawn>>();
function encoderSlotOccupied(path: string): boolean {
  const holder = encoderSlotHolders.get(path);
  return holder !== undefined && holder.exitCode === null && holder.signalCode === null;
}
// Input affects the whole Mac, even when two peers capture different monitors.
const controlOwnership = new DesktopControlOwnership<symbol>();
const FIRST_ACCESS_UNIT_TIMEOUT_MS = 12_000;
const ENCODER_METADATA_TIMEOUT_MS = 5_000;
const ENCODER_LINGER_MS = 3_000;
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

export async function drainEncoderTeardowns(): Promise<void> {
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

export function encoderStdin(shared: SharedEncoder, line: string) {
  writeEncoderControl(shared.child.stdin, line, (error) => {
    diag(`encoder key=${shared.key} control-write-failed error=${String(error)}`);
    killSharedEncoder(shared, "encoder-control-write-failed");
  });
}

export function liveEncoderFor(streamKey: string): SharedEncoder | undefined {
  const shared = sharedEncoders.get(streamKey);
  return shared && !shared.dead ? shared : undefined;
}

/** Every stream of one target, for the decisions that belong to the target: codec, and staleness. */
export function liveEncodersForTarget(captureKey: string): SharedEncoder[] {
  const prefix = `${captureKey}|`;
  const live: SharedEncoder[] = [];
  for (const [key, shared] of sharedEncoders) {
    if (key.startsWith(prefix) && !shared.dead) live.push(shared);
  }
  return live;
}

export function killSharedEncoder(shared: SharedEncoder, reason: string) {
  if (shared.dead) return;
  diag(
    `encoder key=${shared.key} stop reason=${reason} geometry=${shared.geometry} accessUnits=${shared.accessUnits} subscribers=${shared.subscribers.size}`,
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

export function waitForEncoderMetadata(shared: SharedEncoder): Promise<WebrtcTileSourceMetadata> {
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

export function reserveInputRevision(shared: SharedEncoder): number {
  let revision = shared.nextInputRevision;
  while (shared.pendingCursorAcks.has(revision)) {
    revision = revision === Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
  }
  shared.nextInputRevision = revision === Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
  return revision;
}

export function rememberCursorAck(shared: SharedEncoder, revision: number, ack: PendingCursorAck) {
  shared.pendingCursorAcks.set(revision, ack);
  if (shared.pendingCursorAcks.size <= MAX_PENDING_CURSOR_ACKS) return;
  const oldest = shared.pendingCursorAcks.keys().next().value as number | undefined;
  if (oldest !== undefined) shared.pendingCursorAcks.delete(oldest);
}

export async function acquireSharedEncoder(
  captureKey: string,
  binary: string,
  binaryMtimeMs: number,
  args: string[],
  codec: TileVideoCodec,
): Promise<SharedEncoder> {
  const identity = captureIdentity(args);
  const geometry = geometryTag(args);
  const streamKey = encoderStreamKey(captureKey, args);
  // A rebuild retires every stream of this target rather than joining any of them. The viewer pays
  // one reconnect, which is the cost the tile pool already accepts for the same reason, and in
  // exchange an edit to the helper is visible on the next offer instead of whenever the last
  // viewer happens to leave.
  for (const stale of liveEncodersForTarget(captureKey)) {
    if (stale.binaryMtimeMs === binaryMtimeMs) continue;
    diag(`encoder key=${stale.key} retired stale binary mtime=${stale.binaryMtimeMs} -> ${binaryMtimeMs}`);
    killSharedEncoder(stale, "stale-binary");
  }
  const running = liveEncoderFor(streamKey);
  const disposition = encoderDisposition(
    running && { identity: running.identity, subscribers: running.subscribers.size },
    { identity },
  );
  if (running && (disposition === "reuse" || disposition === "join")) {
    if (running.codec !== codec) {
      throw new Error(`shared encoder codec changed from ${running.codec} to ${codec}`);
    }
    diag(
      `encoder key=${running.key} ${disposition} geometry=${running.geometry} wanted=${geometry} accessUnits=${running.accessUnits} subscribers=${running.subscribers.size} cachedKeyframe=${running.latestKeyframe !== null}`,
    );
    return running;
  }
  if (running) killSharedEncoder(running, disposition);

  // Never start a capture on top of one that is still dying; see `encoderTeardowns`.
  await drainEncoderTeardowns();
  // Another offer may have created this encoder while we waited, and a second child for the same
  // target would orphan the first. Joining it is what the rule above would say for any viewer
  // arriving a moment later, and churning a capture somebody just paid for is not worth a
  // geometry.
  const raced = liveEncoderFor(streamKey);
  if (raced && raced.binaryMtimeMs === binaryMtimeMs && raced.codec === codec) {
    diag(`encoder key=${raced.key} adopted after teardown drain geometry=${raced.geometry} subscribers=${raced.subscribers.size}`);
    return raced;
  }
  const slot = acquireEncoderSlot(
    { path: binary, mtimeMs: binaryMtimeMs, exists: true },
    config.gridEncoderSlotsDirectory,
    encoderSlotOccupied,
  );
  const child = Bun.spawn([slot, ...args], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  encoderSlotHolders.set(slot, child);
  const videoDiagnostics = new WebrtcEncoderDiagnostics(`${captureKey}|${geometry}`);
  const shared: SharedEncoder = {
    key: streamKey,
    identity,
    geometry,
    binaryMtimeMs,
    binary: slot,
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
  sharedEncoders.set(streamKey, shared);
  diag(`encoder key=${streamKey} spawn pid=${child.pid} binary=${basename(slot)} geometry=${geometry}`);
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
          diag(`encoder key=${streamKey} meta=${JSON.stringify(meta)}`);
          if (meta.type === "error") {
            stopReason = `encoder-error-${String(meta.message)}`;
            break;
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
            `encoder key=${streamKey} first-access-unit bytes=${frame.payload.length} keyframe=${frame.payload[8] === 1}`,
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

export function subscribeSharedEncoder(shared: SharedEncoder, subscriber: EncoderSubscriber): () => void {
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

export function primeSubscriber(shared: SharedEncoder, subscriber: EncoderSubscriber) {
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
  encoderStdin(shared, "K\n");
}
