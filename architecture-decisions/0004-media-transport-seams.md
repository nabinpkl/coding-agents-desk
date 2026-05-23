---
status: accepted
date: 2026-05-20
---

# Media transport seams for v0

## Context and Problem Statement

ADR-0001 named libwebrtc as the video transport and ScreenCaptureKit + VideoToolbox HEVC as the capture/encode pair. ADR-0003 named the authenticated WebSocket as the only signaling path for SDP and ICE and made the DTLS fingerprint binding structural. Neither ADR addressed how concrete WebRTC code lives in the codebase. R8.6 (hello-pixels) is the first slice that imports a libwebrtc SPM package, instantiates `RTCPeerConnection`, renders a `RTCVideoFrame`, and runs a real ICE handshake. The choice this ADR closes off: whether the rest of the codebase imports libwebrtc directly, or whether it sits behind protocol seams that admit a different stack.

The forcing function is plural. The Apple-platform libwebrtc story has two viable SPM packages (`stasel/WebRTC` for prebuilt Google upstream and `webrtc-sdk/webrtc-build` for HEVC patches). The codec target in `SPEC.md` is HEVC but the prebuilt libwebrtc binaries that ship H.265 vary in build flags and SDP-munging requirements; H.264 is the only codec guaranteed to negotiate against an unmodified upstream. The render path in `SPEC.md` is `AVSampleBufferDisplayLayer` but the natural libwebrtc consumer is `RTCMTLVideoView`; the AVSBDL path requires cracking open libwebrtc's decode pipeline to recover encoded `CMSampleBuffer`s. Each of those is a real choice with a non-obvious tradeoff, and at least two of them are likely to be revisited inside v0's window if HEVC negotiation proves load-bearing for daily-driver acceptance.

This ADR locks the protocol surface (`MediaTransport`, `SignalingChannel`, `VideoFrameSource`, `VideoFrameSink`) and treats the concrete impls behind them as choices, not commitments. The seam is the architectural decision; the first impl is just the first impl.

## Decision Drivers

- Library churn at the WebRTC layer must not propagate into AppDelegate, PairingClient, or any test. The blast radius of a stack swap must be one file.
- The codec target is unsettled. Whether v0 ships H.264 or HEVC is empirically decidable from the 7-day daily-driver test, and that decision must not require touching the transport call sites.
- The renderer target is unsettled for the same reason: `RTCMTLVideoView` is the fast path with libwebrtc; AVSBDL is the SPEC.md target. The seam must accept both without retrofitting.
- Signaling already has a stable shape (ADR-0003's authenticated WebSocket). The transport must consume signaling through a protocol, not by reaching into `PairingSignalingServer` or `SessionDialer`.
- Tests must be able to exercise the wire shape (`WebRTCSignalingFrame`) and the connection-state vocabulary (`MediaConnectionState`) without spinning a real libwebrtc peer.

## Considered Options

1. **Coupling shape.** Import libwebrtc types in AppDelegate and PairingClient directly (status quo if we did nothing); wrap libwebrtc behind a protocol surface; introduce a Swift package boundary around libwebrtc impls.
2. **WebRTC library.** stasel/WebRTC (upstream binaries, H.264 only by default); webrtc-sdk/webrtc-build (HEVC patches, larger binary); build from source (weeks of build infrastructure).
3. **Codec for v0.** H.264 only; HEVC only; preference list resolved at SDP-negotiation time.
4. **Client render path.** `RTCMTLVideoView` (libwebrtc-native); `AVSampleBufferDisplayLayer` (SPEC.md target, requires encoded-frame extraction); custom Metal renderer.
5. **Capture-to-WebRTC bridge.** Implement `RTCVideoCapturer` subclass that wraps ScreenCaptureKit output (the libwebrtc-native bridge); inject pre-encoded `EncodedImage` frames bypassing libwebrtc's encoder.
6. **Signaling frame wire shape.** Reuse the `type`-discriminator pattern from ADR-0003 session frames; introduce a separate envelope for media-plane control.

## Decision Outcome

**1. Protocol seams, no package boundary.** Four protocols live alongside the rest of the host and client source: `MediaTransport`, `SignalingChannel`, `VideoFrameSource` (host), `VideoFrameSink` (client). Concrete impls (e.g. `LibWebRTCMediaTransport`) are the only files allowed to `import WebRTC`. AppDelegate and PairingClient hold a `MediaTransportFactory`, never a concrete transport. A Swift package boundary was considered and rejected: packaging discipline matters when multiple consumers might import the impl, but in a solo-developer two-target codebase the protocol boundary already captures the swap point, and the Xcode-project-level SPM dep is simpler than a multi-package workspace. The protocol files are mirrored between host and client where their shapes overlap, the same way `SharedTypes.swift` is already mirrored under ADR-0002 and ADR-0003.

**2. stasel/WebRTC for v0, swappable.** The v0 SPM dependency is `stasel/WebRTC`. Prebuilt Apple-platform binaries from Google upstream, maintained, widely used, H.264 out of the box. Future swap to `webrtc-sdk/webrtc-build` for HEVC is a one-file change inside `LibWebRTCMediaTransport.swift` or a sibling file that satisfies the same protocols. Building libwebrtc from source was rejected on cost: the build infrastructure burden (depot_tools, gclient, multi-day clean builds, signing the resulting framework) is multiple weeks of work for a swap that ADR-0004's seam already accommodates with hours.

**3. H.264 in v0, codec preference list.** The transport accepts a `MediaCodecPreferences` value type carrying an ordered list of `VideoCodec` cases. v0 ships `[.h264]`. Switching to `[.h265, .h264]` does not require code changes outside the transport impl; if the underlying impl cannot negotiate H.265 (likely with upstream stasel binaries), it falls through to H.264 and the negotiation succeeds. HEVC-only was rejected because the 7-day daily-driver test cannot run until pixels are on the iPhone, and H.264 is the fastest path to that pixel. SDP-munging at the call site (the third option) was rejected because it bakes codec knowledge into the WebRTC-agnostic layer.

**4. RTCMTLVideoView for v0, swappable.** The v0 `VideoFrameSink` impl on the client is `RTCMTLVideoSink`, wrapping `RTCMTLVideoView`. `SPEC.md` previously named `AVSampleBufferDisplayLayer`; that target stands as a v1 follow-up because the AVSBDL path requires recovering encoded `CMSampleBuffer`s from libwebrtc's decode pipeline, which is an order of magnitude more work than wiring up the Metal view libwebrtc already provides. The `VideoFrameSink` protocol's only surface is a `UIView`-typed view property, so an `AVSampleBufferVideoSink` is a drop-in replacement when its time comes.

**5. RTCVideoCapturer subclass for the capture bridge.** On the host, `ScreenCaptureKitFrameSource` produces `CVPixelBuffer` frames at ScreenCaptureKit's native cadence and feeds them to a `ScreenCaptureKitVideoCapturer: RTCVideoCapturer` which wraps each buffer in `RTCCVPixelBuffer` and forwards to the attached `RTCVideoSource` via `capturer:didCapture:`. Injecting pre-encoded frames bypassing libwebrtc's encoder was considered and rejected: libwebrtc's encoder owns bitrate adaptation, SVC layer selection, and keyframe cadence, and circumventing those would fight the library at every reconnect.

**6. WebRTCSignalingFrame matches the session-frame discriminator pattern.** Three cases, sent on the post-`SessionReady` socket: `WebRTCOffer { sdp }`, `WebRTCAnswer { sdp }`, `WebRTCIceCandidate { sdp, sdpMid, sdpMLineIndex }`. Each frame has a `type` field with values `"webrtc-offer"`, `"webrtc-answer"`, `"webrtc-ice"` discriminated by the same first-frame envelope mechanism `PairingSignalingServer` already uses. Compact single-letter JSON keys. A separate envelope around media-plane control was considered and rejected: ADR-0003 already established that everything post-`SessionReady` is on the same authenticated socket, and adding a second envelope layer would be ceremony for no observable benefit.

### Wire shapes

```
WebRTCOffer        { sdp }                                // t: "webrtc-offer"
WebRTCAnswer       { sdp }                                // t: "webrtc-answer"
WebRTCIceCandidate { sdp, sdpMid?, sdpMLineIndex }        // t: "webrtc-ice"
```

JSON with compact keys (`t`, `s`, `m`, `i`) matching the ADR-0003 convention. Sent only after `SessionReady` on the authenticated socket; frames of these types arriving on a connection that has not completed the session handshake are rejected with `SessionRejected(.malformed)`.

### Protocol surface

```swift
protocol MediaTransport: AnyObject {
    func start(role: MediaTransportRole,
               signaling: SignalingChannel,
               videoSource: VideoFrameSource?,
               videoSink: VideoFrameSink?) async throws
    func stop()
    var connectionState: AsyncStream<MediaConnectionState> { get }
}

enum MediaTransportRole { case offerer, answerer }

enum MediaConnectionState { case connecting, connected, disconnected, failed, closed }

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

protocol SignalingChannel: AnyObject {
    func send(_ frame: WebRTCSignalingFrame) async throws
    var inbound: AsyncStream<WebRTCSignalingFrame> { get }
}

protocol VideoFrameSource: AnyObject {
    func start() async throws
    func stop()
    var frames: AsyncStream<CapturedVideoFrame> { get }
}

protocol VideoFrameSink: AnyObject {
    // Concrete type on each platform: NSView on host, UIView on client.
}
```

The `VideoFrameSink` protocol is empty at the seam; the concrete view type is platform-specific and accessed via the impl, not the protocol. This keeps the protocol header free of `UIKit` or `AppKit`, which is what makes it cheap to mirror between host and client.

### Composition root

A single file per side (`MediaStack.swift`) is the only place that names a concrete impl. AppDelegate (host) and PairingClient (client) hold `MediaTransportFactory` by protocol. Swapping the WebRTC library, the codec, the renderer, or the capturer is editing `MediaStack.swift` and no other file.

### Consequences

- Good, because the WebRTC library is now a swap, not a commitment. A future ADR that picks HEVC or a different SPM source touches `MediaStack.swift` and one impl file; the rest of the codebase is invariant.
- Good, because the codec is data (a `MediaCodecPreferences` value), not code. The 7-day daily-driver feedback loop can flip H.264 to HEVC without a code review.
- Good, because tests can substitute an in-memory `SignalingChannel` and verify the wire-frame Codable shape without libwebrtc anywhere in the test bundle.
- Good, because the protocol surface is small enough that a reader can hold it in their head: four protocols, one value type, one enum, three signaling frame cases.
- Bad, because every swap point costs two files (the protocol and the impl). For one-shot impls this is overhead; for v0's plural impl candidates it is the price of the option.
- Bad, because `SPEC.md` previously named HEVC and `AVSampleBufferDisplayLayer` as commitments. Both are now choices, not commitments. The SPEC update lands in the same change as this ADR to keep that consistent.
- Neutral, because the libwebrtc SPM dep is still added to both Xcode projects; the seam saves us from importing `WebRTC` outside the impl files, but it does not save us from the binary-size hit. That cost is independent of this ADR and is already accepted by ADR-0001.

### Confirmation

The decision is being followed if all of the following hold during code review:

- `import WebRTC` appears in exactly two files in the codebase: `host/AgentDeskHost/LibWebRTCMediaTransport.swift` and `client/AgentDeskClient/LibWebRTCMediaTransport.swift`. Auxiliary impl files (the capturer subclass, the render-view wrapper) are permitted to import `WebRTC` as well, but no protocol-layer or call-site file may.
- AppDelegate and PairingClient hold `MediaTransportFactory` by protocol, never a concrete transport type.
- `MediaCodecPreferences` is passed at construction time, not read from a global. Changing the codec is a one-line change in `MediaStack.swift`.
- `WebRTCSignalingFrame` cases are exactly `.offer`, `.answer`, `.ice`. Adding a fourth case requires an ADR amendment.
- Tests exercising the wire shape do not import `WebRTC`.

Any change to the protocol surface, the `MediaConnectionState` vocabulary, or the `WebRTCSignalingFrame` cases requires an ADR that supersedes this one.

## Links

- ADR-0001: locked libwebrtc as the v0 transport. ADR-0004 makes that choice swappable behind a protocol.
- ADR-0003: locked the authenticated WebSocket as the only signaling path. ADR-0004's `SignalingChannel` protocol wraps that socket.
- `SPEC.md`: §Module boundaries gains the four protocol modules; §Wire shapes gains `WebRTCSignalingFrame`; the encode/decode row in the stack table softens from "VideoToolbox HEVC" to "VideoToolbox via libwebrtc, codec preference list, H.264 in v0."
- `TASKS.md`: R8.6 expands into R8.6.1 through R8.6.7 as the implementation slices for this ADR.
- stasel/WebRTC: https://github.com/stasel/WebRTC (the v0 SPM dependency).
- webrtc-sdk/webrtc-build: https://github.com/webrtc-sdk/webrtc-build (the HEVC-capable alternative, tracked for codec follow-up).
