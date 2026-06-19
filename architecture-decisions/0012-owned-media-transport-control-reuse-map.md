---
status: superseded by ADR-0013
date: 2026-06-18
superseded-by: ADR-0013
---

# Owned media transport control and reuse map

## Context and Problem Statement

R24 device testing showed that the current WebRTC media path can make either scroll cadence or desktop text quality acceptable, but not both at the same time. H.264 through WebRTC is smooth only after quality reductions that make text unreadable; VP9 preserves text better but scroll cadence remains visibly stepped; the `stasel/WebRTC` HEVC path is blocked by Apple-platform package reality. This decision maps the next media architecture by what AgentDesk owns and what it reuses, so the next prototype does not become a full remote-desktop rewrite by accident.

Scope: `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift`, `host/AgentDeskHost/MediaTransport.swift`, `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, `client/AgentDeskClient/VideoFrameSink.swift`, `client/AgentDeskClient/RTCMTLVideoSink.swift`, `client/AgentDeskClient/LibWebRTCMediaTransport.swift`, `SPEC.md`, and the R24 work ledger in `TASKS.md`.

## Decision Drivers

- Rest-state text crispness is non-negotiable. Motion can be less crisp while the user scrolls, but the settled frame must return to readable native-density text.
- Scroll output must feel continuous. Input is already smooth enough that output cadence is now the limiting signal.
- Apple hardware codecs should be used directly when the app needs predictable encoder and decoder behavior.
- Receiver buffering, frame pacing, plane switching, and restore timing must be observable and tunable by AgentDesk, not hidden behind a conferencing stack.
- Reuse must stay deliberate. Keep first-party capture, codec, TLS, pairing, auth, and input code where they already fit. Own only the media transport pieces that are currently fighting the product requirement.
- The current WebRTC implementation remains valuable as a baseline and fallback until an owned prototype beats it on the same physical-device trace.

## Considered Options

- **Keep tuning WebRTC dual-plane.** Continue VP9 detail plus H.264 motion inside one PeerConnection.
- **Upgrade or fork WebRTC for HEVC.** Replace `stasel/WebRTC 130.0.0` with an HEVC-capable build or vendor a patched binary.
- **Owned encoded-video transport.** Keep ScreenCaptureKit and VideoToolbox, but move encoded frame transport, pacing, decode, and composition into AgentDesk-owned modules.
- **RDP-style mixed graphics transport.** Add scroll-copy, dirty-region tiles, or later text-aware overlays instead of treating the desktop as one video frame forever.
- **Full custom remote-desktop protocol now.** Replace video, input, pairing, auth, and session management together.

## Decision Outcome

Chose **owned encoded-video transport first, with an explicit bridge to RDP-style mixed graphics later**.

WebRTC remains the bootstrap baseline and current shipping implementation. It should not remain the strategic media primitive for v0 quality. The next prototype should keep the good reused surfaces and replace only the part that needs control:

| Layer | Reuse | Own | Reason |
| --- | --- | --- | --- |
| Capture | `ScreenCaptureKit`, existing display and active-Space selection | Capture cadence policy, per-plane crop/downscale policy | Apple capture is correct; our current missing control is when and how frames enter the codec. |
| Encode | `VideoToolbox` HEVC/H.264 hardware sessions | Encoder session lifecycle, realtime flags, keyframe cadence, bitrate caps, frame dropping | Hardware codec is first-party; WebRTC's encoder wrapper hides too much for this workload. |
| Packet format | None from WebRTC for prototype | Minimal AgentDesk encoded-frame envelope | We need frame IDs, capture timestamps, plane IDs, keyframe flags, dependencies, and restore markers to debug the feel. |
| Transport | Existing TLS identity, pairing, session auth, Tailscale-only assumption | Media stream framing, pacing, backpressure, receiver buffering | Auth and network trust already work; media pacing is the contested layer. |
| Input | Existing dedicated input WebSocket and `InputDispatcher` | Nothing new | Input is not the current bottleneck and should stay isolated from media churn. |
| Decode | `VideoToolbox` on iOS | Decode queue depth, drop policy, playout timing | The client needs direct control over how old frames die and when fresh detail replaces motion. |
| Render | Existing `VideoFrameSink` seam, UIKit container, Metal/AVFoundation surfaces | `AVSampleBufferDisplayLayer` or Metal compositor for owned decoded frames | The existing UI seam is good. The concrete WebRTC renderer is the replaceable part. |
| Detail/rest model | Current full-resolution detail plane as a baseline | Dirty-region or tile refresh protocol after video prototype | Crisp rest text needs a path that is not permanently bound to motion-video compromises. |
| Metrics | Existing R24 capture, RTP, decode, render-cadence log vocabulary | Same metrics without WebRTC stats dependency | The comparison must be apples-to-apples against the current baseline. |

The prototype path is:

1. **Motion-video ownership.** Build a host `VideoToolboxMediaTransport` prototype for the motion plane only: ScreenCaptureKit frame in, HEVC/H.264 encoded access units out, timestamped media frames over an owned session stream, VideoToolbox decode on iOS, render through the existing sink seam.
2. **Rest-detail ownership.** Add a crisp detail refresh path after motion proves cadence. Start with full-frame HEVC detail refresh or high-quality still tiles before attempting text-aware overlays.
3. **Mixed graphics escalation.** Add dirty-region tiles, scroll-copy, or text-aware overlays only if full-frame owned HEVC still cannot meet crisp rest plus smooth scroll.

### Consequences

- Good, because AgentDesk controls the exact surfaces that currently define feel: encoder input size, frame pacing, keyframe cadence, receiver queue depth, late-frame drop, and detail restore.
- Good, because the reuse boundary stays narrow. Pairing, session authentication, input transport, ScreenCaptureKit, VideoToolbox, Keychain, Tailscale, and the UI composition root survive.
- Good, because WebRTC is kept as the measured baseline instead of being removed on faith.
- Bad, because AgentDesk must own packet loss behavior, backpressure, and reconnect semantics for media frames. The prototype must start LAN/Tailscale-only and avoid general internet assumptions.
- Bad, because this weakens ADR-0004's conclusion that a WebRTC library swap is the main media escape hatch. ADR-0004 remains useful for seams, but ADR-0012 changes the proposed direction for media implementation.
- Neutral, because WebRTC can still carry the current implementation until the owned path wins. This decision does not require deleting `LibWebRTCMediaTransport` immediately.

### Confirmation

This decision is being followed if:

- WebRTC changes are limited to baseline maintenance and measurement, not major dependency-chasing for HEVC.
- A new media prototype reuses `SessionAuthenticator`, `SignalingChannel` concepts, existing pairing credentials, and the dedicated input WebSocket instead of creating a second app/session model.
- Prototype logs include capture timestamp, encode start/end, send enqueue/dequeue, receive time, decode start/end, render callback, frame ID, plane ID, dimensions, codec, keyframe flag, and drop reason.
- The prototype is judged against the same physical-device scroll trace as the current dual-plane WebRTC build.
- The prototype is not promoted unless it beats WebRTC on scroll cadence while restoring crisp text at rest.

## Pros and Cons of the Options

### Keep tuning WebRTC dual-plane

- Good, because it reuses the current implementation and avoids new transport code.
- Good, because it already proved the two-plane composition model is the right product shape.
- Bad, because the experiments show the remaining levers trade smoothness against readability.
- Bad, because HEVC exposure depends on fragile third-party WebRTC packaging and upstream codec policy.
- Bad, because receiver buffering and playout behavior remain mostly library-owned.

### Upgrade or fork WebRTC for HEVC

- Good, because it would preserve mature RTP, congestion control, and PeerConnection lifecycle if it worked.
- Good, because it is the smallest conceptual diff from current code.
- Bad, because `stasel/WebRTC` H265-advertised tags M146 through M148 ship macOS slices that fail ObjC import due to missing public headers, while M149 fails SwiftPM checksum validation.
- Bad, because a private WebRTC binary fork makes AgentDesk responsible for Chromium/WebRTC build infrastructure without giving full control over the desktop-remoting semantics.

### Owned encoded-video transport

- Good, because it uses the Apple APIs we actually want: ScreenCaptureKit and VideoToolbox.
- Good, because it gives direct control over latency and frame lifecycle.
- Good, because it can reuse the existing AgentDesk auth, input, config, and UI seams.
- Bad, because it must implement enough flow control and loss recovery to survive real Wi-Fi, even on a tailnet.

### RDP-style mixed graphics transport

- Good, because it matches the problem better than a single fullscreen video stream. Text, tiles, scroll-copy, and video can each have different rules.
- Good, because it is the likely endpoint if crisp rest text remains hard with full-frame HEVC.
- Bad, because it is larger than the next proof needed. Building it before the owned video path risks solving too many unknowns at once.

### Full custom remote-desktop protocol now

- Good, because every behavior would be under AgentDesk control.
- Bad, because it discards working pairing, input, and session infrastructure.
- Bad, because it creates a broad rewrite before the media-only hypothesis has been tested.

## Links

- ADR-0001: original v0 stack named WebRTC plus VideoToolbox HEVC as the intended direction.
- ADR-0004: protocol seams that keep the media implementation swappable.
- ADR-0005: input channel separation, preserved by this decision.
- ADR-0011: session-bound input channel authentication, preserved by this decision.
- `SPEC.md`: Stack, Host MediaTransport, Host VideoFrameSource, Client VideoFrameSink.
- `TASKS.md`: R24 media-output friction ledger and alternatives table.
- Apple VideoToolbox compression properties: `kVTCompressionPropertyKey_RealTime`, `kVTVideoEncoderSpecification_EnableLowLatencyRateControl`, `kVTCompressionPropertyKey_AllowFrameReordering`, `kVTCompressionPropertyKey_ProfileLevel`.
- Microsoft RDP graphics encoding notes: mixed-mode content handling and text-optimized graphics paths.
