# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit menu-bar app via `NSStatusItem` | Fresh implementation, owned end-to-end. Python sister project's pyobjc learnings reused, code is not. |
| iOS client | Swift, UIKit, `AVSampleBufferDisplayLayer` for video | Native required for HEVC crispness and gesture fidelity. Browser path rejected (see PRD). |
| Capture | `ScreenCaptureKit` (macOS 12.3+) | First-party, captures the active Space without composition tricks. |
| Encode / decode | VideoToolbox via libwebrtc, codec preference list | Apple Silicon native. H.264 in v0 per ADR-0004; HEVC tracked as a follow-up through `MediaCodecPreferences`. |
| Transport | libwebrtc via SPM (video) plus a dedicated TLS WebSocket (input), both behind protocol seams | Video on `MediaTransport` (ADR-0004), input on `InputChannel` / `InputChannelServer` (ADR-0005). Two transports per session so video bursts cannot delay input events at the OS-queue / WebRTC-pacer layer. v0 video impl is `stasel/WebRTC`; v0 input impl is `WebSocketInputChannel` over the same TLS port as signaling. |
| Network | Tailscale only | No STUN, TURN, VPS, relay. Both peers are on the tailnet. |
| Pairing | QR code on Mac, scanned by iPhone | One-shot. Signed bearer token stored in Keychain on both sides. |
| Spaces enumeration | Private CoreGraphics: `CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners` | No public API exists. Risk is App Store distribution, which is not the v0 target (Developer ID DMG). |
| Spaces switch | Synthesize `Ctrl+Arrow` via `CGEventCreateKeyboardEvent` + `CGEventPost` | Same path the OS uses for Mission Control's keyboard shortcut. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One code path on the host for all input types. |
| Distribution | Developer ID notarized DMG (Mac), TestFlight internal (iOS) | Apple Developer Program $99/yr. One device. |

ADR-0001 records this stack decision. Reference it for the rejection rationale on React Native, Flutter, browser clients, RustDesk fork, custom transport, AV1, AppleScript, direct CGS space-switch calls, WebAuthn pairing, VoIP/PiP background lifecycle, and Mac App Store distribution. ADR-0004 records the protocol seams that make the WebRTC library, codec, renderer, and capturer swappable without touching call sites.

## Module boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

### Host (macOS)

1. **CaptureEngine.** Owns `ScreenCaptureKit`. Produces `CMSampleBuffer` frames for the active Space on the active display. Interface: `start(displayId) -> AsyncStream<Frame>`, `stop()`.
2. **Encoder.** Wraps VideoToolbox HEVC. Interface: `encode(Frame) -> EncodedChunk`. Hides hardware vs software fallback, keyframe cadence, bitrate adaptation.
3. **SpacesProvider.** Hides the private SkyLight (`/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight`) symbols `CGSMainConnectionID`, `CGSGetActiveSpace`, `CGSCopyManagedDisplaySpaces`, and `CGSManagedDisplaySetCurrentSpace`. Interface: `current() -> DesktopState?`, `switchSpace(direction: SpaceDirection) -> Bool`. Bound dynamically via `dlopen` + `dlsym` so the host project does not need a bridging header or framework link. The R11 backend for Spaces switching; replaces the earlier synthesised-`Ctrl+Arrow` path which depended on user System Settings to be effective. v1's per-agent carousel will extend this with Space-to-agent mapping.
4. **InputDispatcher.** Consumes `NormalizedInput`, emits `CGEvent`. Interface: `dispatch(NormalizedInput)`. Hides the modifier-arm state machine. `.switchSpace` is routed through an injected `switchSpaceHandler` closure that `AppDelegate` wires to `SpacesProvider.switchSpace`; after each successful switch, the handler pushes the fresh `DesktopState` to every active `InputChannelServer` so the client's dots band updates without polling.
5. **Pairing.** Generates QR payload, validates incoming tokens, stores in Keychain. Interface: `mintPairingPayload() -> PairingPayload`, `validate(token) -> SessionToken?`.
6. **SessionAuthenticator.** Runs the per-connection mutual challenge-response defined in ADR-0003 on the `/session` path of the existing TLS WebSocket. Interface: `authenticate(connection) -> ActiveSession`. Throws closed-set rejection reasons. Same test obligation as `Pairing`; the long-term key material is shared.
7. **MediaTransport.** Protocol per ADR-0004. v0 concrete impl `LibWebRTCMediaTransport` wraps libwebrtc and carries the video track. After ADR-0005 the transport is video-only; the `RTCDataChannel` input path was removed. SDP and ICE travel only over an `ActiveSession` produced by `SessionAuthenticator`; the DTLS fingerprint binding is structural. AppDelegate holds a `MediaTransportFactory` by protocol so the library, codec, and capturer can swap behind a single composition root (`MediaStack`).
8. **InputChannelServer.** Per ADR-0005. Owns the host side of the dedicated input WebSocket: validates `InputChannelHello.sessionToken` against `Pairing`, then drains `InputChannelEvent` frames into `events: AsyncStream<NormalizedInput>` for `InputDispatcher`. One instance per active session, owned by `SessionRegistry`. Independent lifecycle from the video PeerConnection.
9. **SignalingChannel.** Protocol per ADR-0004. Wraps the authenticated WebSocket post-`SessionReady`. Carries the three `WebRTCSignalingFrame` cases (`.offer`, `.answer`, `.ice`). Concrete impl `WebSocketSignalingChannel`.
10. **VideoFrameSource.** Protocol per ADR-0004. Concrete impl `ScreenCaptureKitFrameSource` captures the active Space's display at native cadence; a `ScreenCaptureKitVideoCapturer: RTCVideoCapturer` adapter bridges into libwebrtc's `RTCVideoSource`. `TestPatternFrameSource` exists as a diagnostic impl.

### Client (iOS)

1. **VideoFrameSink.** Protocol per ADR-0004. v0 concrete impl `RTCMTLVideoSink` wraps `RTCMTLVideoView` and renders at native DPR. An `AVSampleBufferVideoSink` is a future drop-in via the same protocol; AVSampleBufferDisplayLayer was the original v0 target per ADR-0001 but deferred to v1 in ADR-0004 because the AVSBDL path requires recovering encoded `CMSampleBuffer`s from libwebrtc's decode pipeline.
2. **GestureTranslator.** Converts UIKit gesture recognizers on the trackpad / scroll-strip surface to `NormalizedInput`. Owns cursor pan, scroll, tap, and bare-hold-drag. Multi-touch recognizers stay off the trackpad because the v0 target is one-handed.
3. **SpacesDotsView.** R11 one-handed Spaces switch surface. 32pt horizontal band mounted between the screen-share video sink and the trackpad cluster (positional multiplier 0.55 of view height). Renders one dot per user (`type=0`) Space on the active display; the active dot is filled. State is host-pushed via `DesktopStatePush` over the input WSS; the band hides itself when `count <= 1`. A single-finger horizontal swipe (60pt threshold, 2:1 horizontal:vertical dominance, one emission per gesture) produces `NormalizedInput.switchSpace(direction:)`. Wire shape is the same a three-finger swipe would produce, so the host is unaware of the affordance.
4. **KeyboardSurface.** Compact keyboard plus accessory row. Emits `NormalizedInput { kind: "key" }` and `modifierArm`.
5. **PairingClient.** Camera, QR decode, Keychain write.
6. **SessionDialer.** Mirror of host `SessionAuthenticator`. Drives the four-message handshake from the client side, owns the four-state UI machine (`unpaired | paired-disconnected | connecting | connected`, plus terminal `revoked`), and clears stored credentials on `revoked` / `unknown-device` / `bad-signature` per ADR-0003.
7. **MediaTransport.** Mirror of host. Video-only after ADR-0005; same protocol surface as host, same composition-root pattern via `MediaStack`. PairingClient holds the factory by protocol.
8. **InputChannel.** Per ADR-0005. Owns the client side of the dedicated input WebSocket. Protocol surface: `send(_ input:) async throws`, `close()`. v0 impl `WebSocketInputChannel` wraps one `URLSessionWebSocketTask`. `InputChannelOpener` performs the handshake (sends `InputChannelHello` as the first frame) and returns the ready channel. `PairingClient.attemptSession` opens it alongside the WebRTC session and exposes it via `activeInputChannel`; `PairingViewController.sendInput` routes through it.

Tests required for v0: **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView.** These five are where regressions are most expensive and where the contracts are most stable. `SpacesProvider`'s smoke test is the canary for private-SkyLight surface drift across macOS versions.

## Wire shapes

These come from the grilling prototype and are the load-bearing schemas. Implementations match them; renaming requires an ADR.

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
  | { kind: "scroll", dx: Float, dy: Float }
  | { kind: "dragStart" } | { kind: "dragEnd" }
  | { kind: "switchSpace", direction: "left" | "right" }
  | { kind: "key", code: KeyCode, modifiers: ModifierMask }
  | { kind: "modifierArm", mod: "cmd" | "ctrl" | "option" | "shift" }
```

Pairing crypto details (algorithm, storage, lifetime, nonce TTL) are locked in ADR-0002.

```
PairingPayload {
  hostFingerprint    // SHA-256 over the host's P-256 public key (DER), hex
  hostPublicKey      // host P-256 public key, raw uncompressed, 65 bytes
  tailnetFQDN        // MagicDNS FQDN, may be empty if MagicDNS off
  tailnetIPv4        // CGNAT 100.x.y.z literal, always present
  oneTimeNonce       // 32 random bytes
  expiresAt          // unix seconds, issuedAt + 90
}

SessionToken {
  hostFingerprint    // links token to a specific host identity
  deviceFingerprint  // SHA-256 over the iOS device's P-256 public key
  issuedAt           // unix seconds, informational only (no enforcement)
  signature          // ECDSA P-256 over (hostFingerprint || deviceFingerprint || issuedAt)
}
```

QR encoding: `PairingPayload` is serialized to compact JSON, base64url-encoded, and embedded in a `agentdesk://pair?p=<base64url>` URL.

Session-establishment wire shapes are locked by ADR-0003 and travel on `wss://<host>:<port>/session`, distinct from the `/pair` path used by `PairingPayload`. Post-`SessionReady` media-plane signaling frames are locked by ADR-0004 and travel on the same authenticated socket.

```
SessionInit       { deviceFingerprint, sessionToken, clientNonce }
SessionChallenge  { hostNonce, hostSignature }
SessionProof      { clientSignature }
SessionReady      { }
SessionRejected   { reason }   // reason in { revoked, unknown-device,
                               //             replay, bad-signature,
                               //             malformed, unauthorized }

WebRTCOffer        { sdp }                                // t: "webrtc-offer"
WebRTCAnswer       { sdp }                                // t: "webrtc-answer"
WebRTCIceCandidate { sdp, sdpMid?, sdpMLineIndex }        // t: "webrtc-ice"
```

Input-channel wire shapes are locked by ADR-0005 and travel on a
dedicated WebSocket Secure connection at the same TLS port as
signaling, classified by first-frame discriminator (no URL path
routing; matches the existing `/pair` and `/session` pattern).

```
InputChannelHello  { sessionToken }                       // t: "input-hello"     (client -> host)
InputChannelEvent  { event: NormalizedInput }             // t: "input-event"     (client -> host)
InputChannelClose  { reason }                             // t: "input-close"     (server -> client, optional)
DesktopStatePush   { state: DesktopState }                // t: "desktop-state"   (server -> client, R11)
```

First frame on a new connection MUST be `InputChannelHello`; the host
validates the token via `Pairing.validate(token:)` and closes the
connection with `SessionRejected(.unauthorized)` on mismatch. After the
hello is accepted, subsequent frames are `InputChannelEvent`, one
`NormalizedInput` per WebSocket text frame. The host pushes
`DesktopStatePush` frames in the opposite direction (server -> client)
on session attach and after every successful Spaces switch; the client
uses these to drive the `SpacesDotsView` render. The WSS was already
bidirectional but R11 added the server-pushed direction.

Both signatures are ECDSA-P256 over `"agentdesk-session" || clientNonce || hostNonce || hostFingerprint || deviceFingerprint`. `SessionToken` continues to be issued at pairing approval per ADR-0002 but is reframed as an approval-time receipt that identifies the device to the host's allowlist; it is not sufficient on its own to authenticate a session. The fresh `clientSignature` in `SessionProof` is the authentication. See ADR-0003 for the full canonical encoding, rejection-reason semantics, and the UI state machines.

## Performance budgets

- End-to-end glass-to-glass: **under 80 ms** on Tailscale over local Wi-Fi 6.
- 3-finger swipe to visible Space change on the iPhone: **under one frame at 60 Hz** after the host commits the switch.
- Text crispness: 1080p HEVC at the host's native pixel size, no client-side upscaling tricks.
- Foreground reconnect after background drop: **under 5 seconds**.

## Lifecycle

- Host runs only when the user opens it. No auto-launch on boot (charging-while-docked behavior excluded from v0).
- Client suspends on background; the WebRTC peer is torn down within 1 second; Keychain token and host pubkey persist.
- On foreground, the client transitions to `paired-disconnected` and runs the session-establishment exchange per ADR-0003 using the stored `SessionToken` to identify itself and a fresh `clientSignature` to authenticate. Re-pairing only occurs after a `revoked`, `unknown-device`, `bad-signature`, or `unauthorized` rejection from the host.
- The dedicated input channel (ADR-0005) is opened immediately after session establishment and lives for the session. Its lifecycle is independent of the WebRTC video PeerConnection: a video failure does not tear down input, and vice versa. Reconnection uses the same exponential-backoff policy as `SessionDialer`.

## Risks tracked outside this doc

- Private CoreGraphics API access changes between macOS versions. Mitigation: SpacesProvider is the only consumer, so a future ADR can swap the backend.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback; v0 accepts the dependency.

## Cross-references

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: GitHub issues #2 through #10
