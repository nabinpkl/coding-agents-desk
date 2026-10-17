// The data channel a viewer sends input on, and the transport the panel is handed for it.
//
// Negotiated on every stream, opened only where control is allowed: the sidecar's protocol
// check is the same either way, so a view-only stream still looks like every other offer.

import {
  CONTROL_BUFFER_LIMIT,
  CONTROL_CHANNEL_LABEL,
  type DesktopControlTransport,
} from "@/features/desktop-viewer/tile-stream/webrtcTileWire";
import type { DesktopControlEvent } from "@agentdesk/agent-feed-wire";

export function createControlChannel({
  control,
  finish,
  isCompatible,
  isPublished,
  onControlEvent,
  peer,
  publishControlTransport,
  report,
}: {
  control: boolean;
  /** Ends the session, which is what backpressure on this channel means. */
  finish: (outcome: string) => void;
  /** Whether the answer named a protocol this client speaks. Read at open, not at build. */
  isCompatible: () => boolean;
  /** Whether this transport is the one currently published. */
  isPublished: (transport: DesktopControlTransport) => boolean;
  onControlEvent: ((event: DesktopControlEvent) => void) | undefined;
  peer: RTCPeerConnection;
  publishControlTransport: (transport: DesktopControlTransport | null) => void;
  report: (phase: string, detail?: string) => void;
}) {
  // A stream without control still negotiates the channel, so the sidecar's protocol check
  // is unchanged, but never opens it for input and never publishes a transport.
  const inputChannel = peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true });
  inputChannel.onmessage = (message) => {
    if (!control) return;
    if (typeof message.data !== "string") return;
    try {
      const event = JSON.parse(message.data) as Partial<DesktopControlEvent>;
      if (typeof event.type === "string") {
        onControlEvent?.(event as DesktopControlEvent);
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
    if (isPublished(controlTransport)) publishControlTransport(null);
  };
  inputChannel.onopen = () => {
    if (!control) {
      inputChannel.close();
      return;
    }
    if (!isCompatible()) {
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

  return { inputChannel, controlTransport, clearControlTransport };
}
