# TASKS: v0 media-output friction (with transport alternatives captured)

`R<N>` = remaining. `D<N>` = done. Numbers are stable; retire dropped IDs in the promotion log, never reuse.

Archived history: `tasks/archive/2026-06-16-v0-space-agent-host-overlay.md` carries the closed v0 work through Space Agent plus the first R24 capture.

## Position

The active v0 problem is no longer "can input reach the Mac." Input is smooth. The friction is that the iPhone video output trails during scroll and other high-motion desktop changes.

The next direction is measurement-first. More sender knobs may help, but they are not the architecture until we know where the latency sits. The working order is:

- Verify the actual RTP codec before trusting codec-specific tuning. SDP can report one codec while libwebrtc still sends another if fallback codecs remain enabled.
- Add stage-latency probes before any media-stack replacement. The trace must separate capture, encode, sender pacing, network, receiver buffering, decode, and render.
- Upgrade the WebRTC build only if the trace points to decode, receiver buffering, or missing codec controls.
- Prototype a non-WebRTC transport only if the trace shows WebRTC pacing, congestion control, SDP / ICE ceremony, or unexposed receiver buffering is the remaining cost.

This file is now the active R24 ledger. Closed v0 feature history stays in the archive unless a past decision needs to be referenced.

## v0 Phase 12 (R24): media-output friction and architecture direction

Phase goal: preserve the native-feeling input path while making video output keep up during scroll and cursor-heavy daily-driver use.

What is already on `main`: the cursor path has local prediction, host cursor-position seeding, host held-position integration, and host-driven cursor glyph mirroring. The scroll path sends an interaction hint on scroll-strip touch-down, switches the sender into a low-latency scroll profile, uses a steeper client scroll curve, caps scroll bitrate, and attempts temporal-layer tuning when the negotiated codec supports it.

R24 sub-tasks:

- [x] D24.1. Client cursor prediction. `client/AgentDeskClient/PairingViewController+EdgeFollow.swift` projects `cursorSourcePos` into the video view with local dead-reckoning so drag feedback is immediate instead of waiting for the captured Mac cursor to round-trip through video.
- [x] D24.2. Cursor convergence. `host/AgentDeskHost/SharedTypes.swift`, `client/AgentDeskClient/SharedTypes.swift`, `host/AgentDeskHost/SpacesProvider.swift`, and `host/AgentDeskHost/InputDispatcher.swift` seed the client model from host cursor position and integrate host cursor deltas against a held authoritative position rather than repeatedly reading the lagging WindowServer cursor query.
- [x] D24.3. Cursor glyph mirroring. `host/AgentDeskHost/CursorMonitor.swift`, `host/AgentDeskHost/InputChannelServer.swift`, `client/AgentDeskClient/InputChannel.swift`, `client/AgentDeskClient/CursorImageStore.swift`, and `client/AgentDeskClient/CursorPointerView.swift` push cursor image changes from `NSCursor.currentSystem` and render the client overlay with the host-provided image and hotspot.
- [x] D24.4. Scroll interaction hint. `client/AgentDeskClient/GestureTranslator.swift`, `client/AgentDeskClient/PairingViewController+Gestures.swift`, `host/AgentDeskHost/InputChannelServer.swift`, `host/AgentDeskHost/AppDelegate.swift`, and `host/AgentDeskHost/LibWebRTCMediaTransport.swift` send `interaction-hint` on scroll touch-down, switch to the low-latency sender profile while active, and restore the crisp profile after settle debounce.
- [x] D24.5. Scroll tuning. `client/AgentDeskClient/GestureTranslator.swift` steepens the scroll acceleration curve and lengthens flick coast; `host/AgentDeskHost/MediaTransport.swift` drops scroll profile resolution harder, caps scroll bitrate at 3500 kbps by default, and sets temporal layers to 3 when the negotiated codec supports that path.
- [x] D24.6. Codec reality instrumentation. `host/AgentDeskHost/SharedTypes.swift`, `client/AgentDeskClient/SharedTypes.swift`, `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, and `client/AgentDeskClient/LibWebRTCMediaTransport.swift` parse and log the first negotiated video codec from offer / answer SDP, including H.264 `profile-level-id`; host and client RTP stats now include codec IDs, codec MIME type when libwebrtc reports it, and encoder / decoder implementation fields when present. `Justfile` forwards `AGENTDESK_CODEC` through `host-run`, so `AGENTDESK_CODEC=h264 just fresh-install` exercises the H.264 baseline instead of silently launching the default.
- [x] D24.7. Stage-latency probes. `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift` stamps frames with host uptime at capture callback, `host/AgentDeskHost/WebRTCVideoCapturer.swift` logs capture-to-capturer age, host `LibWebRTCMediaTransport` logs interval encode time per frame and packet-send delay per packet, client `LibWebRTCMediaTransport` logs interval decode time per frame, jitter-buffer delay per emitted frame, playout timestamp when exposed, and render-callback cadence. `MediaTimingMath` in host and client `SharedTypes.swift` backs the interval calculations with focused tests.
- [x] D24.11. Strict codec enforcement. `host/AgentDeskHost/MediaTransport.swift`, `client/AgentDeskClient/MediaTransport.swift`, `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, and `client/AgentDeskClient/LibWebRTCMediaTransport.swift` now filter transceiver codec preferences to the configured primary codecs plus matching RTX and protection codecs. H.264-only runs exclude VP8 and VP9 fallbacks, and host / client stats log a mismatch if the RTP codec escapes the configured set.
- [x] D24.12. H.264 hardware encoder guardrail. The first strict H.264 run connected and selected `video/H264` with `encoder=VideoToolbox`, but outbound RTP stayed black because `framesEncoded=0` and `bytesSent=0` while capture frames kept arriving at 3600x2338. `host/AgentDeskHost/MediaTransport.swift` now derives an H.264-only sender profile that starts downscaled, disables VP9-style temporal layering, and uses `maintainFramerate`. `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift`, `host/AgentDeskHost/VideoFrameSource.swift`, and `host/AgentDeskHost/MediaStack.swift` also downscale the ScreenCaptureKit output before frames enter WebRTC, because sender `scaleResolutionDownBy` alone did not keep VideoToolbox from seeing the native-size frame. Startup logs include capture output size, sender scale, and temporal-layer count.
- [ ] R24.8. WebRTC build decision. If R24.7 or R24.10 shows decode or hidden receiver buffering as the dominant cost, write an ADR deciding whether to upgrade / replace the `stasel/WebRTC` artifact for hardware HEVC or AV1, `jitterBufferTarget` / playout-delay controls if exposed, and current iOS device hardware-decoder support. Land only the build change needed for the measured bottleneck.
- [ ] R24.9. Transport overhaul gate. If R24.7 shows WebRTC pacing, congestion control, SDP / ICE ceremony, or unexposed receiver buffering is the dominant cost after R24.8, write an ADR and branch prototype for `ScreenCaptureKit -> VideoToolbox -> QUIC/WebTransport/MoQ` carrying video plus input on one owned connection. The prototype must beat tuned WebRTC on the same scroll trace before any production replacement work starts.
- [ ] R24.10. Device codec A/B feel pass. The first claimed H.264 device try was invalid as a codec result: offer / answer SDP reported H.264, but outbound RTP stats showed `video/VP8` with `libvpx`. Run VP9-first and H.264-only again after D24.11, capture RTP codec and inbound decoder stats from logs, and record scroll-output latency plus text-crispness observations. Update `SPEC.md` if the shipping v0 codec changes from the current SPEC / ADR-0004 direction.

## Alternatives and Direction

| Option | Direction | What it catches | Failure shape | Gate |
| ------ | --------- | --------------- | ------------- | ---- |
| Keep tuned WebRTC and sender profiles | Default until measurements disprove it | Encoder / pacer pressure during scroll, without replacing the media stack | More knobs can hide a decode or playout-buffer bottleneck and leave output lag unchanged | R24.7 and R24.10 show the remaining cost is small enough |
| H.264 on both ends | First A/B baseline | Hardware decode on iPhone and simpler negotiation | Text may flicker or blur more than VP9, and sender-side VP9 temporal tuning is unavailable | R24.10 shows output latency improves enough to justify visual tradeoff |
| VP9 with temporal layers | Current experimental path | Screen-content compression and bitrate-layer shedding during scroll | iPhone decode may be software-bound, and codec fallback can make the configured preference inert | R24.10 proves VP9 is used on RTP and R24.7 shows decode is not the bottleneck |
| Upgrade the WebRTC build | Second step, only after traces | Hardware codec exposure, lower receiver-buffer controls, codec preference reality | Build churn without stage timing may swap binaries while preserving the same latency source | R24.7 points to decode or receiver buffering and the newer build exposes the needed control |
| VideoToolbox plus QUIC/WebTransport/MoQ | Prototype only after WebRTC is measured as the problem | Full ownership of jitter buffer, pacing, migration, and codec path | Reimplements loss recovery and pacing before proving WebRTC transport is the bottleneck | R24.9 ADR plus prototype beats tuned WebRTC on the same trace |
| Code-aware crisp-text overlay | Captured, not active | Separates text legibility from video codec quality | Adds a second rendering model and risks drifting from the real desktop | Revisit only if text crispness remains a steady-state v0 friction after media latency is acceptable |

### Rejected For Now

- A direct transport overhaul before instrumentation. Rejected because the observed symptom can come from software decode, receiver buffering, or render scheduling. Revisit after R24.7.
- More aggressive scroll-profile tuning without codec verification. Rejected because the latest VP9 temporal-layer work may be inert if the client negotiates H.264. Revisit after R24.10.
- A second parallel low-quality video stream kept warm. Rejected because it pays continuous encode / bandwidth cost and complicates sync. Revisit only if single-stream profile switching cannot react fast enough after measurement.

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
R24.10    pending     pending     rerun physical-device VP9-first versus H.264-only after strict RTP codec enforcement and H.264 guardrail
```
