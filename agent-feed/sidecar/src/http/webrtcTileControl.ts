// Who owns input on this Mac, and what a viewer is allowed to send while it does.
//
// One data channel per peer, and ONE owner across every peer: input reaches the whole machine,
// so two viewers capturing different monitors still contend for the same cursor and keyboard.
// The ownership is taken on the first message that means to drive something and released when
// the channel closes, so a viewer that only watches never takes it from one that is working.
//
// Its own object because the channel is a closure over five things that have to agree -- the
// channel, the owner symbol, the encoder input goes to, and the two message counters -- and the
// answer that builds the peer has no other reason to hold any of them.

import type {
  DesktopControlEvent,
  DesktopControlInput,
} from "@agentdesk/agent-feed-wire";
import type { RTCDataChannel, RTCPeerConnection } from "werift";
import {
  desktopControlInput,
  desktopControlLine,
  desktopControlRejectionReason,
} from "./webrtcDesktopControl.ts";
import { DesktopControlOwnership } from "./webrtcDesktopControlOwnership.ts";
import { diag } from "./webrtcDiagnosticsLog.ts";
import {
  encoderStdin,
  rememberCursorAck,
  reserveInputRevision,
  type SharedEncoder,
} from "./webrtcEncoderPool.ts";

// Input affects the whole Mac, even when two peers capture different monitors.
const controlOwnership = new DesktopControlOwnership<symbol>();
const controlOwners = new Map<symbol, { encoder: SharedEncoder; revoke: (epoch: number) => void }>();

/** One peer's control channel, and the input owner it may take. */
export interface TileControl {
  /** The encoder input is written to. Null until the capture has been acquired. */
  encoder: SharedEncoder | null;
  /** The symbol this peer owns input as; the encoder subscriber is keyed by it too. */
  readonly inputOwner: symbol;
  send: (event: DesktopControlEvent) => void;
  /** Gives up input ownership, if this peer holds it. Called on channel close and on shutdown. */
  release: () => void;
  /** Whether the channel is open, which decides if a snapshot is worth sending. */
  isOpen: () => boolean;
}

/**
 * Wires the peer's control channel and returns the handle the answer keeps.
 *
 * Subscribes at build time, before the offer is applied, because the channel arrives with the
 * remote description and a subscription added afterwards would miss it.
 */
export function createTileControl({
  captureDisplayId,
  connection,
  peer,
}: {
  captureDisplayId: string | undefined;
  connection: number;
  peer: RTCPeerConnection;
}): TileControl {
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
  return {
    get encoder() { return inputEncoder; },
    set encoder(value: SharedEncoder | null) { inputEncoder = value; },
    inputOwner,
    send: sendControl,
    release: releaseInputOwner,
    isOpen: () => currentControlChannel()?.readyState === "open",
  };
}
