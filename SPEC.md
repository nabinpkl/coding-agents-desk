# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit menu-bar app via `NSStatusItem` plus a floating `NSPanel` Space Agent | Fresh implementation, owned end-to-end. The menu-bar host remains the server/status process; Space Agent is a local desktop navigator. |
| iOS client | Swift, UIKit, `AVSampleBufferDisplayLayer` for remote video | Native required for text crispness and gesture fidelity. Browser path rejected in `PRD.md`. |
| Capture | `ScreenCaptureKit` on macOS 12.3+ | First-party active-display capture without composition tricks. |
| Encode / decode | Hardware-required VideoToolbox, HEVC by default and H.264 as an explicit owned-media codec setting | Rest-state text crispness depends on hardware screen-content quality. Strict ceiling probes can request 4:4:4 or BGRA capture, HEVC profile, and max QP. |
| Transport | Owned authenticated QUIC datagrams for video, dedicated TLS WebSocket for input | ADR-0015 makes this the only active media path. Input stays reliable and independent. Video owns packet repair, stale-frame skip, and keyframe recovery. |
| Network | Tailscale only | No public rendezvous, relay, or internet routing. Both peers are on the tailnet. |
| Pairing | QR code on Mac, scanned by iPhone | One-shot approval. Signed token stored in Keychain on both sides. |
| Spaces enumeration | Private SkyLight/CoreGraphics symbols bound with `dlopen` and `dlsym` | No public API exists. Risk is acceptable because App Store distribution is not the v0 target. |
| Spaces switch | Synthesize Dock swipe `CGEvent`s via `SpacesProvider.postDockSwipeFrame` and `commitStep(delta:)` | Stock macOS path that preserves live Space transition animation. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One host code path for all remote input. |
| Distribution | Developer ID notarized DMG for Mac, TestFlight internal for iOS | One author, one device. |

ADR-0001 records the original v0 stack decision. ADR-0015 records the current media architecture.

## Module Boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

### Host

1. **CaptureEngine.** Owns ScreenCaptureKit. Produces `CMSampleBuffer` frames for the active display.
2. **Encoder.** Wraps VideoToolbox and produces `OwnedMediaFrameEnvelope` payloads. It fails the media path if the required hardware encoder cannot start.
3. **SpacesProvider.** Enumerates Spaces through SkyLight/CoreGraphics bindings and forwards Space-swipe gestures through Dock-handled events.
4. **InputDispatcher.** Consumes `NormalizedInput` and emits `CGEvent`. Space-switch gestures stream through the injected `SpacesProvider` handler.
5. **Pairing.** Generates QR payloads, validates approval tokens, and stores allowlisted devices in Keychain-backed state.
6. **SessionAuthenticator.** Runs the per-connection mutual challenge-response on the authenticated session socket. Produces `SessionReady` with input and media capabilities.
7. **MediaTransport.** Starts one owned QUIC media channel. The first datagram is `MediaChannelHello`; the host validates the media capability through `SessionRegistry`, replies with `MediaChannelReady`, derives the per-session HMAC key, and sends authenticated `ADMD` v2 packets.
8. **InputChannelServer.** Owns the host side of the dedicated input WebSocket. Validates `InputChannelHello` against `SessionRegistry`, drains `InputChannelEvent` frames into `NormalizedInput`, and pushes desktop state, thumbnails, cursor updates, and agent speech events.
9. **SignalingChannel.** Wraps the authenticated session WebSocket after `SessionReady`. It carries low-frequency input capability refresh messages only.
10. **VideoFrameSource.** Concrete implementation `ScreenCaptureKitFrameSource` captures one stream for the active display. `TestPatternFrameSource` exists as a diagnostic source.
11. **SpaceThumbnailProvider.** Host-local thumbnail source for Spaces, enabled by owner-scoped demand.
12. **SpaceAgent.** Host-local overlay under `host/AgentDeskHost/SpaceAgent/`, showing the draggable spaceship and active-display Spaces strip.
13. **DictationBar.** Host-local push-to-talk overlay under `host/AgentDeskHost/DictationBar/`, independent of the iPhone media and input channels.

### Client

1. **VideoFrameSink.** Concrete implementation `OwnedMediaVideoSink` owns one `AVSampleBufferDisplayLayer`, decodes `OwnedMediaFrameEnvelope` payloads, and renders the active display surface. It preserves delta continuity by enqueuing complete deltas, and flushes queued display history only when the layer reports failure or requires flush to resume. Attached console traces split the owned-media lifecycle into host capture/admission/encode/send/ACK, transport packet completion and repair, client complete-to-render enqueue, and estimated display-layer state. Display traces explicitly mark `displayPresentation=estimated`; true on-screen presentation timing is not claimed with the current `AVSampleBufferDisplayLayer` renderer.
2. **GestureTranslator.** Converts UIKit gestures on the trackpad and scroll-strip surfaces to `NormalizedInput`. It does not send media quality hints.
3. **SpacesDotsView.** One-handed Spaces switch surface driven by `DesktopStatePush` from the input channel.
4. **KeyboardSurface.** Compact keyboard plus accessory row. Emits key and modifier input frames.
5. **PairingClient.** Camera, QR decode, token verification, and Keychain write.
6. **SessionDialer.** Client mirror of session authentication. Owns the connected/disconnected UI machine and clears stored credentials on terminal rejection.
7. **MediaTransport.** Opens one QUIC datagram connection to the host, performs the media nonce handshake, verifies `ADMD` v2 packets, repairs missing packet indexes before deadline, skips stale delta frames, and asks for keyframe recovery only when decoder continuity requires it.
8. **InputChannel.** Dedicated TLS WebSocket for remote input and host pushes. It opens alongside the authenticated session using the input capability from `SessionReady`.

Tests required for v0: **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView.** Additional owned-media contract tests pin wire shapes, packet repair, and decoder recovery behavior where regressions are expensive.

## Wire Shapes

These schemas are load-bearing. Renaming requires an ADR.

```
DisplayMetadata { id, name, isMain, nativePixelSize }
SpaceMetadata   { id, displayId, index }
DesktopState    { displays: [DisplayMetadata],
                  spaces: [SpaceMetadata],
                  activeDisplayId, activeSpaceId }
```

```
NormalizedInput =
  | { kind: "cursorMove", dx: Float, dy: Float }
  | { kind: "click", button: "left" | "right" | "double" }
  | { kind: "scroll", dx: Float, dy: Float, phase?: "began"|"changed"|"ended"|"cancelled" }
  | { kind: "dragStart" } | { kind: "dragEnd" }
  | { kind: "switchSpaceGesture", phase: "began"|"changed"|"ended"|"cancelled", progress: Float, velocityX: Float }
  | { kind: "key", code: KeyCode, modifiers: ModifierMask }
  | { kind: "modifierArm", mod: "cmd" | "ctrl" | "option" | "shift" }
```

Pairing crypto details are locked in ADR-0002.

```
PairingPayload {
  hostFingerprint
  hostPublicKey
  tailnetFQDN
  tailnetIPv4
  oneTimeNonce
  expiresAt
}

SessionToken {
  hostFingerprint
  deviceFingerprint
  issuedAt
  signature
}
```

Session establishment is locked by ADR-0003 and ADR-0011.

```
SessionInit       { deviceFingerprint, sessionToken, clientNonce }
SessionChallenge  { hostNonce, hostSignature }
SessionProof      { clientSignature }
SessionReady      { sessionId, inputCapability, inputCapabilityExpiresAt,
                    mediaCapability, mediaCapabilityExpiresAt }
InputCapabilityRefreshRequest { deviceFingerprint, sessionId }       // t: "input-capability-refresh"
InputCapabilityGrant { sessionId, inputCapability, inputCapabilityExpiresAt } // t: "input-capability-grant"
SessionRejected   { reason }
```

Owned media travels over QUIC datagrams after `SessionReady`.

```
MediaChannelHello { deviceFingerprint, sessionId, mediaCapability, clientNonce } // t: "media-hello"
MediaChannelReady { sessionId, serverNonce }                                      // t: "media-ready"
OwnedMediaControlMessage { kind: "keyframe-request", frameId }                    // t: "owned-media-control"
OwnedMediaControlMessage { kind: "packet-resend-request", frameId, packetIndexes } // compact key px
OwnedMediaControlMessage { kind: "frame-ack", frameId, totalFramesDecoded,
                           renderGapMs, clientBacklogFrames,
                           clientBacklogBytes }                                  // compact keys td, rg, qf, qb

The host derives `frameAgeMs` for admission by matching `frame-ack.frameId` to
its sent-frame table and comparing the original capture timestamp with host
uptime when the ACK arrives. The iPhone does not send this value because host
and device monotonic clocks are not comparable.

ADMD packet =
  "ADMD" || version=2 || kind=3 || flags: UInt8 ||
  generation=0: UInt32BE || frameId: UInt64BE ||
  packetIndex: UInt16BE || packetCount: UInt16BE ||
  sentAtUptimeNs: UInt64BE || payloadLength: UInt16BE ||
  hmacSha256(headerWithoutMac || payload) || payload

flags bit 0 = keyframe

OwnedMediaFrameEnvelope =
  "ADMF" || version=1 || headerLength: UInt32BE || headerJSON || payload

OwnedMediaFrameHeader {
  frameId,
  codec: "hevc" | "h264",
  width, height,
  capturedAtUptimeNs,
  presentationTimeNs,
  isKeyframe,
  parameterSets?,
  payloadFormat: "length-prefixed-nal"
}
```

The payload is the VideoToolbox access-unit sample data with length-prefixed NAL units. Keyframes carry codec parameter sets in the JSON header so the iOS receiver can create or refresh its `CMVideoFormatDescription` before enqueueing the sample buffer.

Input-channel wire shapes are locked by ADR-0005 and ADR-0011.

```
InputChannelHello  { deviceFingerprint, sessionId, inputCapability } // t: "input-hello"
InputChannelReady  { sessionId }                                      // t: "input-ready"
InputChannelEvent  { event: NormalizedInput }                         // t: "input-event"
InputChannelClose  { reason }                                         // t: "input-close"
DesktopStatePush   { state: DesktopState }                            // t: "desktop-state"
```

## Recovery Policy

- Packet repair is first resort. The client sends one missing-index request per frame repair window.
- The host resend ring keeps exact authenticated datagrams and resends only requested indexes still in the ring.
- Capture freshness is enforced before VideoToolbox. The host keeps one latest raw capture frame, coalesces stale pending captures while transport is busy or the client is behind, and only encodes frames it intends to send.
- Frame ACKs are the host-side admission fence. Normal cadence allows two unacknowledged frames, behind cadence allows one, and draining cadence allows none until ACKs clear or the drain timeout permits one recovery keyframe.
- If a behind or draining frame stays unacknowledged past the stale-unacked deadline, the host abandons it for admission accounting and forces the next admitted frame to be a recovery keyframe. This prevents one lost lifecycle ACK from freezing capture admission, while preserving decoder continuity after any abandoned reference frame.
- Explicit keyframe requests are deferred while draining. Periodic keyframes are suppressed while behind or draining, and a second keyframe is blocked while a prior keyframe is unacknowledged.
- Once a frame is encoded, the host sends the whole frame. Backpressure adjusts encode cadence and datagram pacing; it does not drop encoded delta frames.
- A frame repaired before the deadline renders in order.
- An expired delta frame is skipped as stale output.
- An expired keyframe, decoder failure, malformed packet, or authentication failure requests keyframe recovery.

## Performance Budgets

- End-to-end glass-to-glass: under 80 ms on Tailscale over local Wi-Fi 6.
- Space-swipe to visible Space change on the iPhone: under one frame at 60 Hz after host commit.
- Text crispness: native Retina-scale capture at rest, no client-side upscaling trick.
- Foreground reconnect after background drop: under 5 seconds.

## Lifecycle

- Host runs only when the user opens it. No auto-launch on boot.
- Space Agent appears while the host runs and captures thumbnails only through owner-scoped demand.
- Client suspends on background; media and input channels close within one second while Keychain token and host public key persist.
- Foreground reconnect runs the session-establishment exchange using the stored approval token plus a fresh client signature.
- Video failure does not tear down input, and input failure does not tear down video. Host-side revocation deletes the allowlist row and tears down active signaling, input, media transport, input task, input capability, and media capability state for that device.

## Risks Tracked Outside This Doc

- Private CoreGraphics API drift between macOS versions. Mitigation: `SpacesProvider` is the only consumer.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback in v0.

## Cross-References

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: `TASKS.md`
