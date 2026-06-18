# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit menu-bar app via `NSStatusItem` plus a floating `NSPanel` Space Agent | Fresh implementation, owned end-to-end. The menu-bar host remains the server/status process; Space Agent is a local desktop navigator. Python sister project's pyobjc learnings reused, code is not. |
| iOS client | Swift, UIKit, `RTCMTLVideoView` for WebRTC video, `AVSampleBufferDisplayLayer` for the owned media prototype | Native required for text crispness and gesture fidelity. Browser path rejected (see PRD). Both renderers sit behind `VideoFrameSink` so media transport can change without changing the touch UI. |
| Capture | `ScreenCaptureKit` (macOS 12.3+) | First-party, captures the active Space without composition tricks. |
| Encode / decode | WebRTC codec preferences by default, hardware-required VideoToolbox for `AGENTDESK_MEDIA_STACK=owned` | The default WebRTC path keeps VP9 detail at full capture resolution and H.264 motion with env-tunable capture-level downscale. The owned prototype uses VideoToolbox HEVC by default, H.264 when `AGENTDESK_OWNED_MEDIA_CODEC=h264`, and fails the media path if the required hardware encoder cannot start. |
| Transport | libwebrtc via SPM by default, owned authenticated media WebSocket behind `AGENTDESK_MEDIA_STACK=owned`, dedicated TLS WebSocket for input | Video is behind `MediaTransport` (ADR-0004), input is behind `InputChannel` / `InputChannelServer` (ADR-0005), with auth bound to a proven session per ADR-0011. The default video PeerConnection carries two warm tracks, `detail-video` and `motion-video`. The owned prototype reuses pairing, session auth, Tailscale, and the input channel, then carries `ADMF` encoded-frame envelopes over a separate authenticated WebSocket. |
| Network | Tailscale only | No STUN, TURN, VPS, relay. Both peers are on the tailnet. |
| Pairing | QR code on Mac, scanned by iPhone | One-shot. Signed bearer token stored in Keychain on both sides. |
| Spaces enumeration | Private SkyLight/CoreGraphics symbols bound with `dlopen` + `dlsym` | No public API exists. Risk is App Store distribution, which is not the v0 target (Developer ID DMG). |
| Spaces switch | Synthesize Dock swipe `CGEvent`s via `SpacesProvider.postDockSwipeFrame` and `commitStep(delta:)` | Stock macOS path that does not depend on Mission Control keyboard shortcuts or SIP-disabled Dock injection. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One code path on the host for all input types. |
| Distribution | Developer ID notarized DMG (Mac), TestFlight internal (iOS) | Apple Developer Program $99/yr. One device. |

ADR-0001 records this stack decision. Reference it for the rejection rationale on React Native, Flutter, browser clients, RustDesk fork, custom transport, AV1, AppleScript, direct CGS space-switch calls, WebAuthn pairing, VoIP/PiP background lifecycle, and Mac App Store distribution. ADR-0004 records the protocol seams that make the WebRTC library, codec, renderer, and capturer swappable without touching call sites.

## Module boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

### Host (macOS)

1. **CaptureEngine.** Owns `ScreenCaptureKit`. Produces `CMSampleBuffer` frames for the active Space on the active display. Interface: `start(displayId) -> AsyncStream<Frame>`, `stop()`.
2. **Encoder.** Wraps VideoToolbox HEVC. Interface: `encode(Frame) -> EncodedChunk`. Hides hardware vs software fallback, keyframe cadence, bitrate adaptation.
3. **SpacesProvider.** Two responsibilities. (a) Enumeration via the SkyLight private framework (`/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight`); probes `SLSMainConnectionID` / `SLSGetActiveSpace` / `SLSCopyManagedDisplaySpaces` first and falls back to the `CGS*` legacy aliases. Bound dynamically via `dlopen` + `dlsym`. (b) Dock-swipe forwarding: `postDockSwipeFrame(phase:progress:velocityX:)` posts one synthesised CGEvent per call (`kCGSEventDockControl` + `kIOHIDEventTypeDockSwipe`, horizontal motion, CGSGesturePhase mapping `began=1 / changed=2 / ended=4 / cancelled=8`). The Dock listens for the stream and animates the Spaces transition in real time, then commits or snaps back at Ended based on the terminal progress + velocity. Unprivileged path; same Accessibility permission we use for cursor + keyboard. Direct setter `SLSManagedDisplaySetCurrentSpace` is restricted to `Dock.app` (yabai's SIP-disable case). Interface: `current() -> DesktopState?`, `postDockSwipeFrame(phase:progress:velocityX:) -> Bool`.
4. **InputDispatcher.** Consumes `NormalizedInput`, emits `CGEvent`. Interface: `dispatch(NormalizedInput)`. Hides the modifier-arm state machine. `.switchSpaceGesture` streams through an injected `switchSpaceGestureHandler` closure that `AppDelegate` wires to `SpacesProvider.postDockSwipeFrame`; the dispatcher's serial queue preserves the Began -> Changed* -> Ended order the Dock expects. `AppDelegate` subscribes to `NSWorkspace.activeSpaceDidChangeNotification` (on `NSWorkspace.shared.notificationCenter`, not `default`) so every committed switch (iPhone-initiated, F3, four-finger swipe, Mission Control click, full-screen) triggers a fresh `DesktopState` broadcast to all active `InputChannelServer`s.
5. **Pairing.** Generates QR payload, validates incoming tokens, stores in Keychain. Interface: `mintPairingPayload() -> PairingPayload`, `validate(token) -> SessionToken?`.
6. **SessionAuthenticator.** Runs the per-connection mutual challenge-response defined in ADR-0003 on the `/session` path of the existing TLS WebSocket. Interface: `authenticate(connection) -> ActiveSession`. Throws closed-set rejection reasons. Same test obligation as `Pairing`; the long-term key material is shared.
7. **MediaTransport.** Protocol per ADR-0004. Default concrete impl `LibWebRTCMediaTransport` wraps libwebrtc and carries two video tracks in one PeerConnection: `detail-video` and `motion-video`. `AGENTDESK_MEDIA_STACK=owned` selects `OwnedMediaTransport`, which takes the same `VideoPlaneSources`, encodes each active plane with a hardware-required VideoToolbox compression session, and writes timestamped `OwnedMediaFrameEnvelope` binary frames through `OwnedMediaChannelServer`. After ADR-0005 the transport is video-only; the `RTCDataChannel` input path was removed. SDP and ICE travel only over an `ActiveSession` produced by `SessionAuthenticator`; the DTLS fingerprint binding is structural for WebRTC. The owned media channel validates a separate per-session media capability before accepting binary frames. AppDelegate holds a `MediaTransportFactory` by protocol so the library, codec, and capturer can swap behind a single composition root (`MediaStack`). `MediaPlaneConfiguration.defaultPlanes` sets full-resolution VP9 for detail and capture-downscaled H.264 for motion in the WebRTC path; `AGENTDESK_TUNING_MOTION_CAPTURE_SCALE_DOWN` tunes the WebRTC motion capture scale and the motion sender scale remains `1.0` so quality is not downscaled twice.
8. **InputChannelServer.** Per ADR-0005 and ADR-0011. Owns the host side of the dedicated input WebSocket: validates `InputChannelHello.sessionId` and `InputChannelHello.inputCapability` against an active session in `SessionRegistry`, then drains `InputChannelEvent` frames into `events: AsyncStream<NormalizedInput>` for `InputDispatcher`. One instance per active session, owned by `SessionRegistry`. Independent lifecycle from the video PeerConnection.
9. **SignalingChannel.** Protocol per ADR-0004 and ADR-0011. Wraps the authenticated WebSocket post-`SessionReady`. Carries WebRTC signaling frames (`.offer`, `.answer`, `.ice`) plus low-frequency `InputCapabilityRefreshRequest` / `InputCapabilityGrant` frames. The owned media path does not put binary media on this socket; it uses `MediaChannelHello` as the first frame of a new connection and then takes ownership of that WebSocket after `MediaChannelReady`. Concrete impl `WebSocketSignalingChannel`.
10. **VideoFrameSource.** Protocol per ADR-0004. Concrete impl `ScreenCaptureKitFrameSource` captures the active Space's display at native cadence and can apply capture-level downscale before frames enter WebRTC. The host runs one source for the detail plane at native capture size and one for the motion plane at the configured H.264 capture scale. `WebRTCVideoCapturer` bridges each source into libwebrtc's `RTCVideoSource`; `TestPatternFrameSource` exists as a diagnostic impl.
11. **SpaceThumbnailProvider.** Host-local thumbnail source for Spaces. Uses `ScreenCaptureKit` plus an isolated SkyLight `SLSCopySpacesForWindows` binding to map windows to Spaces and composite 128x80 JPEG thumbnails. Surface: `setDemand(owner:enabled:)`, `forceRefresh(spaceId:)`, `thumbnails: AsyncStream<[UInt64: Data]>`. It is shared by the iPhone preview strip and the host Space Agent through owner-scoped demand; it captures only while at least one owner needs thumbnails.
12. **SpaceAgent.** Host-local overlay under `host/AgentDeskHost/SpaceAgent/`. `SpaceAgentController` owns a floating non-activating `NSPanel`, persisted screen position, expanded/collapsed state, `NSWorkspace.activeSpaceDidChangeNotification` observation, and thumbnail-demand ownership. `SpaceAgentViewController` renders the small draggable bitmap spaceship and the attached horizontal active-display Spaces strip. `SpaceAgentModel` derives view models from `DesktopState` and thumbnail bytes, with placeholder tiles when thumbnails are unavailable. Tile selection calls `SpacesProvider.commitStep(delta:)` and leaves the panel expanded. The current menu-bar popover remains pairing/status UI; Space Agent is independent and starts visible with the host app.
13. **DictationBar.** Host-local push-to-talk overlay under `host/AgentDeskHost/DictationBar/`, per ADR-0010. A borderless non-activating `NSPanel` pinned to the bottom-centre of the main screen, joining all Spaces, with a push-to-talk mic control. Push-to-talk also binds to holding the Fn / Globe key (a global `flagsChanged` monitor watching the `.function` modifier; needs the Accessibility grant the host already holds). `MicRecorder` captures the default input via `AVAudioEngine` and an `AVAudioConverter` into an in-memory 16 kHz mono 16-bit PCM buffer (never a file); `WAVEncoder` wraps it into a WAV `Data`; `TranscriptionClient` POSTs it to the OpenAI-compatible `Config.transcriptionEndpoint` as `multipart/form-data` (fields `file` and `model`) and decodes `{ "text": ... }`. The transcript is typed at the focused cursor via `InputDispatcher.typeText` (CGEvent `keyboardSetUnicodeString`, layout-independent) and also shown in the bar; the panel is non-activating so focus stays with the frontmost app. Independent of the iPhone media/input pipeline. Requires the `com.apple.security.device.audio-input` Hardened Runtime entitlement and the `NSAllowsLocalNetworking` ATS exception for `http://localhost`.

### Client (iOS)

1. **VideoFrameSink.** Protocol per ADR-0004. Default concrete impl `DualPlaneVideoSink` owns two `RTCMTLVideoSink` renderers, one per media plane, and exposes one container view to the UI. The compositor shows the detail plane by default, switches to motion immediately on scroll touch-down, and restores detail only after a fresh detail-plane render callback. `RTCMTLVideoSink` wraps `RTCMTLVideoView` and renders at native DPR. `AGENTDESK_MEDIA_STACK=owned` uses `OwnedMediaVideoSink`, which owns the active `AVSampleBufferDisplayLayer` instances advertised by `SessionReady.mediaPlanes` and renders encoded HEVC or H.264 samples from `OwnedMediaFrameEnvelope` payloads. If the host advertises only `detail`, scroll interaction does not switch to a missing motion layer. `PairingViewController` also mounts a transparent screen-trackpad overlay above the video sink; it is disabled by default and becomes a relative cursor / tap surface when `SettingsStore.inputSurfaceMode == .screenTrackpad`.
2. **GestureTranslator.** Converts UIKit gesture recognizers on the trackpad / scroll-strip surface, and optionally the video overlay, to `NormalizedInput`. Owns cursor pan, scroll, tap, and bare-hold-drag. Multi-touch recognizers stay off the trackpad because the v0 target is one-handed. The screen-trackpad overlay uses the same relative cursor and tap recognizers as the dedicated trackpad while the right-edge strip remains the scroll surface.
3. **SpacesDotsView.** R11 one-handed Spaces switch surface. 32pt horizontal band mounted between the screen-share video sink and the trackpad cluster. Renders one dot per user (`type=0`) Space on the active display; the active dot is filled. State is host-pushed via `DesktopStatePush` over the input WSS; the band hides itself when `count <= 1`. A single-finger horizontal pan streams `NormalizedInput.switchSpaceGesture(phase:progress:velocityX:)` frames continuously (Began -> Changed* -> Ended/Cancelled) so the host can drive the Dock's Space-transition animation in real time. Progress is normalised to band width and clamped to ±1; velocity passes through pts/s.
4. **KeyboardSurface.** Compact keyboard plus accessory row. Emits `NormalizedInput { kind: "key" }` and `modifierArm`.
5. **PairingClient.** Camera, QR decode, Keychain write.
6. **SessionDialer.** Mirror of host `SessionAuthenticator`. Drives the four-message handshake from the client side, owns the four-state UI machine (`unpaired | paired-disconnected | connecting | connected`, plus terminal `revoked`), and clears stored credentials on `revoked` / `unknown-device` / `bad-signature` per ADR-0003.
7. **MediaTransport.** Mirror of host. Video-only after ADR-0005; same protocol surface as host, same composition-root pattern via `MediaStack`. In the default WebRTC path the client applies per-plane codec preferences in the answer and attaches `detail-video` / `motion-video` to the matching renderers inside `DualPlaneVideoSink`. In the owned path `OwnedMediaTransport` opens the media WebSocket with `MediaChannelHello`, waits for `MediaChannelReady`, decodes `ADMF` binary envelopes, and sends frames to `OwnedMediaVideoSink`. PairingClient holds the active media mode, media capability, media planes, host, and port after session establishment so the view controller can create the correct transport and sink.
8. **InputChannel.** Per ADR-0005 and ADR-0011. Owns the client side of the dedicated input WebSocket. Protocol surface: `send(_ input:) async throws`, `close()`, host-push streams, and `closed`. v0 impl `WebSocketInputChannel` wraps one `URLSessionWebSocketTask`. `InputChannelOpener` performs the handshake by sending `InputChannelHello { deviceFingerprint, sessionId, inputCapability }` as the first frame and returns the ready channel. `PairingClient.attemptSession` opens it alongside the WebRTC session and exposes it via `activeInputChannel`; `PairingViewController.sendInput` routes through it.

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
  | { kind: "switchSpaceGesture", phase: "began"|"changed"|"ended"|"cancelled", progress: Float, velocityX: Float }
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
  issuedAt           // unix seconds, approval receipt timestamp
  signature          // ECDSA P-256 over (hostFingerprint || deviceFingerprint || issuedAt)
}
```

QR encoding: `PairingPayload` is serialized to compact JSON, base64url-encoded, and embedded in a `agentdesk://pair?p=<base64url>` URL.

Session-establishment wire shapes are locked by ADR-0003 and travel on `wss://<host>:<port>/session`, distinct from the `/pair` path used by `PairingPayload`. Post-`SessionReady` WebRTC media-plane signaling frames are locked by ADR-0004 and travel on the same authenticated socket. The owned media prototype adds a separate per-session media capability, scoped to the same active session.

```
SessionInit       { deviceFingerprint, sessionToken, clientNonce }
SessionChallenge  { hostNonce, hostSignature }
SessionProof      { clientSignature }
SessionReady      { sessionId, inputCapability, inputCapabilityExpiresAt,
                    mediaMode, mediaCapability, mediaCapabilityExpiresAt,
                    mediaPlanes }
InputCapabilityRefreshRequest { deviceFingerprint, sessionId }       // t: "input-capability-refresh"
InputCapabilityGrant { sessionId, inputCapability, inputCapabilityExpiresAt } // t: "input-capability-grant"
SessionRejected   { reason }   // reason in { revoked, unknown-device,
                               //             replay, bad-signature,
                               //             malformed, unauthorized,
                               //             expired-input-capability,
                               //             stale-input-capability,
                               //             expired-media-capability,
                               //             stale-media-capability }

WebRTCOffer        { sdp }                                // t: "webrtc-offer"
WebRTCAnswer       { sdp }                                // t: "webrtc-answer"
WebRTCIceCandidate { sdp, sdpMid?, sdpMLineIndex }        // t: "webrtc-ice"
```

Owned-media channel wire shapes are part of the R24.9 prototype and travel on a
new WebSocket connection after `SessionReady`. First-frame classification routes
`MediaChannelHello` to the media path. The host validates
`mediaCapability` against `SessionRegistry`, sends `MediaChannelReady`, removes
the connection from normal signaling tracking, and then sends binary media
frames only.

```
MediaChannelHello { deviceFingerprint, sessionId, mediaCapability } // t: "media-hello" (client -> host)
MediaChannelReady { sessionId }                                     // t: "media-ready" (host -> client)

OwnedMediaFrameEnvelope =
  "ADMF" || version=1 || headerLength: UInt32BE || headerJSON || payload

OwnedMediaFrameHeader {
  frameId,
  plane: "detail" | "motion",
  codec: "hevc" | "h264",
  width, height,
  capturedAtUptimeNs,
  presentationTimeNs,
  isKeyframe,
  parameterSets?,
  payloadFormat: "length-prefixed-nal"
}
```

The payload is the VideoToolbox access-unit sample data with length-prefixed NAL
units. Keyframes carry codec parameter sets in the JSON header so the iOS
receiver can create or refresh its `CMVideoFormatDescription` before enqueueing
the sample buffer.

Input-channel wire shapes are locked by ADR-0005 and ADR-0011 and travel on a
dedicated WebSocket Secure connection at the same TLS port as
signaling, classified by first-frame discriminator (no URL path
routing; matches the existing `/pair` and `/session` pattern).

```
InputChannelHello  { deviceFingerprint, sessionId, inputCapability } // t: "input-hello" (client -> host)
InputChannelReady  { sessionId }                          // t: "input-ready"     (host -> client)
InputChannelEvent  { event: NormalizedInput }             // t: "input-event"     (client -> host)
InputChannelClose  { reason }                             // t: "input-close"     (server -> client, optional)
DesktopStatePush   { state: DesktopState }                // t: "desktop-state"   (server -> client, R11)
```

First frame on a new connection MUST be `InputChannelHello`; the host
validates the input capability against an active ADR-0003 session in
`SessionRegistry` and closes the connection with `SessionRejected` on
mismatch, expiry, or stale capability. After the hello is accepted, the
host sends `InputChannelReady` for that session id, then subsequent client
frames are `InputChannelEvent`, one `NormalizedInput` per WebSocket text
frame. The host pushes `DesktopStatePush` frames in the
opposite direction (server -> client) on session attach and after every
successful Spaces switch; the client uses these to drive the
`SpacesDotsView` render. The WSS was already bidirectional but R11 added
the server-pushed direction.

Both signatures are ECDSA-P256 over `"agentdesk-session" || clientNonce || hostNonce || hostFingerprint || deviceFingerprint`. `SessionToken` continues to be issued at pairing approval per ADR-0002 but is reframed as an approval-time receipt that identifies the device to the host's allowlist; it is not sufficient on its own to authenticate a session or open an input channel. The fresh `clientSignature` in `SessionProof` is the authentication. ADR-0011 adds a per-session input capability returned by `SessionReady`; input reconnects refresh that capability through `InputCapabilityRefreshRequest` / `InputCapabilityGrant` on the authenticated session channel, not through the input WebSocket. See ADR-0003 and ADR-0011 for canonical encoding, rejection-reason semantics, and input capability rotation.

## Performance budgets

- End-to-end glass-to-glass: **under 80 ms** on Tailscale over local Wi-Fi 6.
- 3-finger swipe to visible Space change on the iPhone: **under one frame at 60 Hz** after the host commits the switch.
- Text crispness: full-resolution detail plane at rest, no client-side upscaling tricks.
- Foreground reconnect after background drop: **under 5 seconds**.

## Lifecycle

- Host runs only when the user opens it. No auto-launch on boot (charging-while-docked behavior excluded from v0).
- Space Agent appears while the host runs. It is a small draggable spaceship overlay that joins all Spaces where AppKit permits. Clicking the spaceship expands or collapses an attached active-display Spaces panel. Thumbnail capture is enabled only while expanded and only through owner-scoped demand on the shared `SpaceThumbnailProvider`.
- Client suspends on background; the WebRTC peer is torn down within 1 second; Keychain token and host pubkey persist.
- On foreground, the client transitions to `paired-disconnected` and runs the session-establishment exchange per ADR-0003 using the stored `SessionToken` to identify itself and a fresh `clientSignature` to authenticate. Re-pairing only occurs after a `revoked`, `unknown-device`, `bad-signature`, or `unauthorized` rejection from the host.
- The dedicated input channel (ADR-0005, ADR-0011) is opened immediately after session establishment with the per-session input capability returned by `SessionReady` and lives for the session. Its lifecycle is independent of the video transport: a video failure does not tear down input, and vice versa. Reconnection uses the same exponential-backoff policy as `SessionDialer`, but input capability refresh happens only over the authenticated session channel. In the owned media path the media channel is opened with the per-session media capability returned by `SessionReady`; there is no unauthenticated media socket. Host-side revocation deletes the allowlist row and tears down the active signaling channel, input channel, media transport, input task, owned media channel, outstanding input capability, and outstanding media capability for that device.

## Risks tracked outside this doc

- Private CoreGraphics API access changes between macOS versions. Mitigation: SpacesProvider is the only consumer, so a future ADR can swap the backend.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback; v0 accepts the dependency.

## Cross-references

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: GitHub issues #2 through #10
