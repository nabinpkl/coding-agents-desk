---
name: libwebrtc-weak-refs
description: libwebrtc's ObjC layer holds weak refs from peer/receiver/capturer into the Swift-side track/source/sink. Local variables get deallocated between subscribe and first-frame, and the symptom is silent — "frames flow but the renderer/capturer never fires." Retain on self.
metadata:
  type: feedback
---

When wiring stasel/WebRTC (libwebrtc Apple binaries) into Swift, every Swift object that participates in the media path must be stored as a strong property on the owning transport, not as a local variable that escapes via callbacks or async tasks.

**Why:** libwebrtc's ObjC-side classes (RTCPeerConnection, RTCRtpReceiver, RTCVideoCapturer) hold *weak* references into the Swift objects you hand them. When the Swift-side strong ref count drops to zero, the chain silently breaks. There is no error, no log, no exception; the renderer or capturer just stops being called. We hit this exact bug twice in two days, on opposite sides of the same pipeline:

  1. Host: `let rtcSource = factory.videoSource(); let capturer = WebRTCVideoCapturer(rtcSource: ...); pc.add(track, streamIds: ["s0"])` — `rtcSource` was a local, deallocated when start() returned. RTCVideoCapturer.delegate is weak, so the capturer's delegate went nil and every captured frame was dropped. Fix: store `rtcVideoSource` and `videoTrack` as properties on the transport.

  2. Client: `let track = transceiver.receiver.track as? RTCVideoTrack; track.add(renderer)` — `track` was a local. By the time the decoder produced the first frame, the local was gone. The renderer chain had no live track to fire into, so renderFrame: was never invoked. Fix: store `remoteVideoTrack` as a property on the transport.

**How to apply:** For every WebRTC type you pull out of a callback or factory call (RTCVideoSource, RTCVideoCapturer, RTCVideoTrack, RTCAudioTrack, RTCRtpReceiver, RTCDataChannel), default to assigning it to a stored property on `self` before doing anything else with it. Clear those properties only in `stop()` or `deinit`. Do not assume the surrounding RTCPeerConnection holds the track alive; it doesn't reliably.

Corollary: do not wrap `track.add(renderer)` in `Task { @MainActor in ... }`. The async dispatch widens the window between subscribing and first-frame delivery. `track.add` is thread-safe; call it synchronously from whatever delegate thread fires. Tonight's bug got worse because the @MainActor task body ran after the synchronous capture had already gone out of scope.

Diagnostic surface for next time: a `DebugFrameProbeRenderer` (plain RTCVideoRenderer, no Metal, just logs `setSize`/`renderFrame`) lives in [[client-LibWebRTCMediaTransport]]. Attaching it alongside RTCMTLVideoView immediately tells you whether the problem is "track not delivering" (probe silent) or "RTCMTLVideoView specifically not painting" (probe fires, view stays black). Same for the host: `outbound-rtp framesEncoded` periodic stats and the capturer's `deliveredCount` log distinguish "capturer not getting frames" from "frames captured but encoder/wire stuck."
