# TASKS: v0 media-output friction (with transport alternatives captured)

`R<N>` = remaining. `D<N>` = done. Numbers are stable; retire dropped IDs in the promotion log, never reuse.

Archived history: `tasks/archive/2026-06-16-v0-space-agent-host-overlay.md` carries the closed v0 work through Space Agent plus the first R24 capture.

## Position

The active v0 problem is no longer "can input reach the Mac." Input is smooth. The friction is that the iPhone video output trails during scroll and other high-motion desktop changes.

The next direction is dual-plane WebRTC with measurement kept in place. More sender knobs did not preserve both constraints at once. The working order is:

- Keep two warm video planes in one PeerConnection: a full-resolution VP9 detail plane for rest-state text and a capture-downscaled H.264 motion plane for scroll.
- Switch the client compositor to motion immediately on scroll touch-down.
- Restore the detail plane only after a fresh detail frame renders, so at-rest text returns crisp instead of showing the stale or downscaled motion plane.
- Upgrade the WebRTC build only if the dual-plane trace points to decode, receiver buffering, or missing codec controls.
- Prototype a non-WebRTC transport only if the dual-plane trace shows WebRTC pacing, congestion control, SDP / ICE ceremony, or unexposed receiver buffering is the remaining cost.

This file is now the active R24 ledger. Closed v0 feature history stays in the archive unless a past decision needs to be referenced.

## v0 Phase 12 (R24): media-output friction and architecture direction

Phase goal: preserve the native-feeling input path while making video output keep up during scroll and cursor-heavy daily-driver use.

What is already on `main`: the cursor path has local prediction, host cursor-position seeding, host held-position integration, and host-driven cursor glyph mirroring. The scroll path sends an interaction hint on scroll-strip touch-down, uses a steeper client scroll curve, and now drives a client compositor that switches between hot detail and motion video planes.

R24 sub-tasks:

- [x] D24.1. Client cursor prediction. `client/AgentDeskClient/PairingViewController+EdgeFollow.swift` projects `cursorSourcePos` into the video view with local dead-reckoning so drag feedback is immediate instead of waiting for the captured Mac cursor to round-trip through video.
- [x] D24.2. Cursor convergence. `host/AgentDeskHost/SharedTypes.swift`, `client/AgentDeskClient/SharedTypes.swift`, `host/AgentDeskHost/SpacesProvider.swift`, and `host/AgentDeskHost/InputDispatcher.swift` seed the client model from host cursor position and integrate host cursor deltas against a held authoritative position rather than repeatedly reading the lagging WindowServer cursor query.
- [x] D24.3. Cursor glyph mirroring. `host/AgentDeskHost/CursorMonitor.swift`, `host/AgentDeskHost/InputChannelServer.swift`, `client/AgentDeskClient/InputChannel.swift`, `client/AgentDeskClient/CursorImageStore.swift`, and `client/AgentDeskClient/CursorPointerView.swift` push cursor image changes from `NSCursor.currentSystem` and render the client overlay with the host-provided image and hotspot.
- [x] D24.4. Scroll interaction hint. `client/AgentDeskClient/GestureTranslator.swift`, `client/AgentDeskClient/PairingViewController+Gestures.swift`, `host/AgentDeskHost/InputChannelServer.swift`, `host/AgentDeskHost/AppDelegate.swift`, and `host/AgentDeskHost/LibWebRTCMediaTransport.swift` send `interaction-hint` on scroll touch-down, switch to the low-latency sender profile while active, and restore the crisp profile after settle debounce.
- [x] D24.5. Scroll tuning. `client/AgentDeskClient/GestureTranslator.swift` steepens the scroll acceleration curve and lengthens flick coast; `host/AgentDeskHost/MediaTransport.swift` drops scroll profile resolution harder, caps scroll bitrate at 3500 kbps by default, and sets temporal layers to 3 when the negotiated codec supports that path.
- [x] D24.6. Codec reality instrumentation. `host/AgentDeskHost/SharedTypes.swift`, `client/AgentDeskClient/SharedTypes.swift`, `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, and `client/AgentDeskClient/LibWebRTCMediaTransport.swift` parse and log the first negotiated video codec from offer / answer SDP, including H.264 `profile-level-id`; host and client RTP stats now include codec IDs, codec MIME type when libwebrtc reports it, and encoder / decoder implementation fields when present. `Justfile` forwards `AGENTDESK_CODEC` through `host-run`, so `AGENTDESK_CODEC=h264 just fresh-install` exercises the H.264 baseline instead of silently launching the default.
- [x] D24.7. Stage-latency probes. `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift` stamps frames with host uptime at capture callback, `host/AgentDeskHost/WebRTCVideoCapturer.swift` logs capture-to-capturer age, host `LibWebRTCMediaTransport` logs interval encode time per frame and packet-send delay per packet, client `LibWebRTCMediaTransport` logs interval decode time per frame, jitter-buffer delay per emitted frame, playout timestamp when exposed, and render-callback cadence. `MediaTimingMath` in host and client `SharedTypes.swift` backs the interval calculations with focused tests.
- [x] D24.11. Strict codec enforcement. `host/AgentDeskHost/MediaTransport.swift`, `client/AgentDeskClient/MediaTransport.swift`, `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, and `client/AgentDeskClient/LibWebRTCMediaTransport.swift` now filter transceiver codec preferences to the configured primary codecs plus matching RTX and protection codecs. H.264-only runs exclude VP8 and VP9 fallbacks, and host / client stats log a mismatch if the RTP codec escapes the configured set.
- [x] D24.12. H.264 hardware encoder guardrail. The first strict H.264 run connected and selected `video/H264` with `encoder=VideoToolbox`, but outbound RTP stayed black because `framesEncoded=0` and `bytesSent=0` while capture frames kept arriving at 3600x2338. `host/AgentDeskHost/MediaTransport.swift` now derives H.264-only sender guardrails that disable VP9-style temporal layering and use `maintainFramerate`. `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift`, `host/AgentDeskHost/VideoFrameSource.swift`, and `host/AgentDeskHost/MediaStack.swift` downscale the ScreenCaptureKit output before frames enter WebRTC, because sender `scaleResolutionDownBy` alone did not keep VideoToolbox from seeing the native-size frame. Startup logs include capture output size, sender scale, and temporal-layer count.
- [x] D24.13. H.264 post-scroll restore. The first non-black H.264 run restored from scroll to the same sender `scaleDown=3.5` used during scroll, so quality stayed in the low-resolution profile after the interaction ended. `host/AgentDeskHost/MediaTransport.swift` now keeps H.264 crisp sender scale at the base profile while leaving the hardware-safety downscale in the ScreenCaptureKit source, and `host/AgentDeskHost/LibWebRTCMediaTransport.swift` applies the crisp profile at sender startup so startup and post-scroll restore match.
- [x] D24.14. Hot dual-plane renderer. `MediaTransport.start` now carries `VideoPlaneSources` / `VideoPlaneSinks`. The host creates two warm WebRTC video tracks in one PeerConnection: `detail-video` uses VP9 at full ScreenCaptureKit resolution for rest-state text, and `motion-video` uses H.264 with capture-level downscale for low-latency scroll. The client receives both tracks into `DualPlaneVideoSink`, switches visible output to motion on scroll start, and switches back to detail only after a fresh detail frame render callback. The old host-side interaction hint no longer mutates one sender profile; it remains as a logged compatibility signal while the client compositor owns the visible plane.
- [x] D24.15. Motion-plane quality floor. The first dual-plane device feel pass showed scroll was smoother but motion output was too blurred to read. The cause was double downscale: ScreenCaptureKit capture downscale `3.5x` plus WebRTC sender scale `3.5x`, for roughly `12.25x` linear reduction. `host/AgentDeskHost/MediaTransport.swift` now derives motion-plane H.264 guardrails with sender `scaleResolutionDownBy=1.0` while keeping the capture-level H.264 hardware guardrail. `host/AgentDeskHostTests/ScrollQualityTests.swift` pins this so the double-downscale cannot return.
- [ ] R24.8. WebRTC build decision. If R24.7 or R24.10 shows decode or hidden receiver buffering as the dominant cost, write an ADR deciding whether to upgrade / replace the `stasel/WebRTC` artifact for hardware HEVC or AV1, `jitterBufferTarget` / playout-delay controls if exposed, and current iOS device hardware-decoder support. Land only the build change needed for the measured bottleneck.
- [ ] R24.9. Transport overhaul gate. If R24.7 shows WebRTC pacing, congestion control, SDP / ICE ceremony, or unexposed receiver buffering is the dominant cost after R24.8, write an ADR and branch prototype for `ScreenCaptureKit -> VideoToolbox -> QUIC/WebTransport/MoQ` carrying video plus input on one owned connection. The prototype must beat tuned WebRTC on the same scroll trace before any production replacement work starts.
- [ ] R24.10. Device dual-plane feel pass. Run the hot dual-plane build on the physical iPhone, capture per-plane RTP codec and inbound decoder stats from logs, and record scroll-output latency plus rest-state text crispness. Update `SPEC.md` if the shipping v0 plane codecs change from D24.14.

## Alternatives and Direction

| Option | Direction | What it catches | Failure shape | Gate |
| ------ | --------- | --------------- | ------------- | ---- |
| Hot dual-plane WebRTC | Active direction | Rest text stays on the full-resolution detail plane while scroll uses a capture-downscaled-only motion plane | Continuous dual encode can cost CPU, bandwidth, or receiver decode headroom | R24.10 shows crisp rest text and smoother scroll on device |
| Keep tuned WebRTC and sender profiles | Superseded by D24.14 | Encoder / pacer pressure during scroll, without replacing the media stack | One plane could not keep scroll smooth and rest text crisp after H.264 downscale | Revisit only if dual-plane continuous cost is worse than switching cost |
| H.264 on both ends | Superseded as sole stream | Hardware decode on iPhone and simpler negotiation | At-rest text was unreadable after the quality reductions required for scroll | Keep as the motion plane while detail uses VP9 |
| VP9 with temporal layers | Superseded as sole stream | Screen-content compression and bitrate-layer shedding during scroll | Scroll remained visibly laggy despite rest-state crispness | Keep as the detail plane unless device stats prove decode is the bottleneck |
| Upgrade the WebRTC build | Second step, only after traces | Hardware codec exposure, lower receiver-buffer controls, codec preference reality | Build churn without stage timing may swap binaries while preserving the same latency source | R24.7 points to decode or receiver buffering and the newer build exposes the needed control |
| VideoToolbox plus QUIC/WebTransport/MoQ | Prototype only after WebRTC is measured as the problem | Full ownership of jitter buffer, pacing, migration, and codec path | Reimplements loss recovery and pacing before proving WebRTC transport is the bottleneck | R24.9 ADR plus prototype beats tuned WebRTC on the same trace |
| Code-aware crisp-text overlay | Captured, not active | Separates text legibility from video codec quality | Adds a second rendering model and risks drifting from the real desktop | Revisit only if text crispness remains a steady-state v0 friction after media latency is acceptable |

### Rejected For Now

- A direct transport overhaul before instrumentation. Rejected because the observed symptom can come from software decode, receiver buffering, or render scheduling. Revisit after R24.7.
- More aggressive scroll-profile tuning without codec verification. Rejected because the latest VP9 temporal-layer work may be inert if the client negotiates H.264. Revisit after R24.10.
- A cold second stream or negotiated stream replacement on scroll. Rejected because scroll needs an already-hot plane. D24.14 keeps both planes warm and pays the continuous cost deliberately.

## Promotion log

```
D24.1     2026-06-16  committed   client cursor prediction overlay for zero-latency pointer feedback
D24.2     2026-06-16  committed   host cursor seed plus held-position integration fixed at-rest drift
D24.3     2026-06-16  committed   host cursor glyph push and client mirrored cursor overlay
D24.4     2026-06-16  committed   scroll interaction hint toggles low-latency sender profile
D24.5     2026-06-16  committed   scroll acceleration, bitrate cap, and temporal-layer tuning landed
D24.6     2026-06-16  committed   negotiated-codec logging, RTP implementation stats, and AGENTDESK_CODEC launcher forwarding landed
D24.7     2026-06-16  committed   capture, outbound RTP, inbound RTP, jitter, decode, and render-cadence probes landed
D24.11    2026-06-16  committed   strict codec preferences prevent H.264-only runs from falling back to VP8 or VP9
R24.8     pending     pending     decide WebRTC build upgrade only if measurements point there
R24.9     pending     pending     gate custom VideoToolbox plus QUIC/WebTransport/MoQ prototype on measured WebRTC bottleneck
D24.12    2026-06-16  committed   H.264-only capture and sender profiles now start inside the VideoToolbox encode path instead of producing black RTP
D24.13    2026-06-16  committed   H.264 restore keeps crisp sender scale separate from low-resolution scroll scale
D24.14    2026-06-17  committed   hot dual-plane renderer keeps VP9 detail and H.264 motion planes warm in one PeerConnection
D24.15    2026-06-17  committed   motion plane removes sender-side double-downscale and keeps only capture-level H.264 downscale
R24.10    pending     pending     rerun physical-device feel pass with per-plane RTP and decoder stats
```
