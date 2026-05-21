---
name: libwebrtc-issue-when-screen-share-from-mac-to-iphone
description: Trigger-pattern recognizer for the libwebrtc-Swift weak-ref bug we hit twice doing Mac-to-iPhone screen share. If you're calling factory.videoSource / factory.videoTrack / transceiver.receiver.track and then handing the result into pc.add / track.add / capturer.init, store it on self first or it will deallocate silently.
metadata:
  type: feedback
---

## When you are doing this

- Wiring stasel/WebRTC (libwebrtc Apple binaries) into a Swift class.
- Pulling out an `RTCVideoSource`, `RTCVideoTrack`, `RTCVideoCapturer`, `RTCAudioTrack`, `RTCRtpReceiver`, or `RTCDataChannel` from a factory method or delegate callback.
- Passing that object into `pc.add(track, streamIds:)`, `track.add(renderer)`, or using it to construct a capturer.
- Doing it in a function where the object is a `let` local, an async-let, or captured by a `Task { ... }` / `DispatchQueue.async` closure.

## And you face this

- Pipeline reports healthy on both sides: signaling fine, ICE connected, `media state=connected`.
- Host stats show `outbound-rtp framesEncoded` climbing and `bytesSent` increasing.
- Client stats show `inbound-rtp framesDecoded` climbing and `packetsLost=0`.
- But the visible thing fails: capturer's `deliveredCount` stays at 0 with "delegate is nil; frame dropped" in the log, OR `RTCMTLVideoView` renders pure black, OR `RTCVideoRenderer.renderFrame:` is never called on any subscriber, OR `RTCVideoViewDelegate.didChangeVideoSize` never fires.
- No errors. No exceptions. No crash. Just silence on the side that should be receiving.

## Solution

Store the object as a strong property on `self` *before* you do anything else with it. Not as a local. Not in a captured closure. On `self`.

```swift
// WRONG: rtcSource is a local; libwebrtc's capturer holds it weakly
let rtcSource = factory.videoSource()
let capturer = WebRTCVideoCapturer(rtcSource: rtcSource, ...)
pc.add(factory.videoTrack(with: rtcSource, trackId: "v0"), streamIds: ["s0"])
// rtcSource deallocates here → capturer.delegate goes nil → frames dropped

// RIGHT
self.rtcVideoSource = factory.videoSource()
self.videoTrack = factory.videoTrack(with: self.rtcVideoSource!, trackId: "v0")
let capturer = WebRTCVideoCapturer(rtcSource: self.rtcVideoSource!, ...)
pc.add(self.videoTrack!, streamIds: ["s0"])
```

```swift
// WRONG: track is a local; track.add inside Task runs after it deallocates
let track = transceiver.receiver.track as? RTCVideoTrack
Task { @MainActor in track?.add(renderer) }

// RIGHT
guard let track = transceiver.receiver.track as? RTCVideoTrack else { return }
self.remoteVideoTrack = track          // retain FIRST
track.add(renderer)                    // call synchronously, not in a Task
```

Clear the properties only in `stop()` or `deinit`.

Do NOT wrap `track.add(renderer)` in `Task { @MainActor in ... }`. libwebrtc's `add` is thread-safe; the async dispatch widens the window where your locally-captured track can deallocate before the body runs. Call it synchronously from whatever thread the delegate fires on.

## Why this trips us specifically

We hit this twice in two days, both sides of the pipeline, with identical symptoms (silent failure, healthy stats). [[project_signing_pivot]]-era debugging burnt hours before recognizing the pattern. RTCPeerConnection looks like it should own the track once you call `pc.add(track, streamIds:)`, but it stores a weak ref. Same for the receiver side. Treat libwebrtc as "I give you the only strong ref; I keep weak."

## Diagnostic surface kept in the codebase

When the symptom recurs, before guessing, look at these (they are already wired):

- Host `WebRTCVideoCapturer.deliver(_:)` — logs `delivered frame #N` every 30 frames AND `capturer delegate is nil; frame dropped` if the weak ref died.
- Host `LibWebRTCMediaTransport.startStatsLogger()` — `outbound-rtp framesEncoded / bytesSent / targetBitrate` every 2s.
- Client `LibWebRTCMediaTransport.startStatsLogger()` — `inbound-rtp framesReceived / framesDecoded / bytesReceived / packetsLost` every 2s.
- Client `DebugFrameProbeRenderer` (attached alongside `RTCMTLVideoView`) — `probe renderFrame #N` every 30 frames. If probe is silent but `framesDecoded` is climbing, it's the weak-ref bug. If probe fires but the view stays black, it's an `RTCMTLVideoView`-specific issue (different bug, look elsewhere).
- Client `videoView(_:didChangeVideoSize:)` — first-frame size from libwebrtc's delegate. Fires once when the renderer receives its first frame.

Reading those four logs in order tells you exactly which stage broke without needing to add new instrumentation.
