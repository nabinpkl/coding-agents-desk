# TASKS: v0 media-output friction (with transport alternatives captured)

`R<N>` = remaining. `D<N>` = done. Numbers are stable; retire dropped IDs in the promotion log, never reuse.

Archived history: `tasks/archive/2026-06-16-v0-space-agent-host-overlay.md` carries the closed v0 work through Space Agent plus the first R24 capture.

## Position

The active v0 problem is no longer "can input reach the Mac." Input is smooth. The friction is that the iPhone video output trails during scroll and other high-motion desktop changes.

The next direction is measurement-first. More sender knobs may help, but they are not the architecture until we know where the latency sits. The working order is:

- Verify the actual negotiated codec before trusting VP9-specific tuning. The host currently defaults to VP9-first, while the iOS client factory still advertises H.264-only.
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
- [ ] R24.6. Codec reality check. Add a log or test hook in `host/AgentDeskHost/LibWebRTCMediaTransport.swift` / `client/AgentDeskClient/LibWebRTCMediaTransport.swift` that records the actually negotiated video codec from the offer / answer or transceiver state, then run H.264-only versus VP9-first on device and record scroll-output latency and text-crispness observations. Update `SPEC.md` if the shipping v0 codec is no longer H.264 per ADR-0004.
- [ ] R24.7. Stage-latency probes. Add timestamped diagnostics across `ScreenCaptureKitFrameSource`, `LibWebRTCMediaTransport`, `WebRTCVideoCapturer`, and the client sink path so one scroll session reports capture-to-encode, encode-to-send, send-to-receive, receive-to-decode, decode-to-render, and rendered-frame freshness. The output must distinguish decode cost from WebRTC jitter / playout buffering and sender pacing.
- [ ] R24.8. WebRTC build decision. If R24.6 or R24.7 shows decode or hidden receiver buffering as the dominant cost, write an ADR deciding whether to upgrade / replace the `stasel/WebRTC` artifact for hardware HEVC or AV1, `jitterBufferTarget` / playout-delay controls if exposed, and current iOS device hardware-decoder support. Land only the build change needed for the measured bottleneck.
- [ ] R24.9. Transport overhaul gate. If R24.7 shows WebRTC pacing, congestion control, SDP / ICE ceremony, or unexposed receiver buffering is the dominant cost after R24.8, write an ADR and branch prototype for `ScreenCaptureKit -> VideoToolbox -> QUIC/WebTransport/MoQ` carrying video plus input on one owned connection. The prototype must beat tuned WebRTC on the same scroll trace before any production replacement work starts.

## Alternatives and Direction

| Option | Direction | What it catches | Failure shape | Gate |
| ------ | --------- | --------------- | ------------- | ---- |
| Keep tuned WebRTC and sender profiles | Default until measurements disprove it | Encoder / pacer pressure during scroll, without replacing the media stack | More knobs can hide a decode or playout-buffer bottleneck and leave output lag unchanged | R24.6 and R24.7 show the remaining cost is small enough |
| H.264 on both ends | First A/B baseline | Hardware decode on iPhone and simpler negotiation | Text may flicker or blur more than VP9, and sender-side VP9 temporal tuning is unavailable | R24.6 shows output latency improves enough to justify visual tradeoff |
| VP9 with temporal layers | Current experimental path | Screen-content compression and bitrate-layer shedding during scroll | iPhone decode may be software-bound, and client H.264-only negotiation can make it inert | R24.6 proves VP9 is negotiated and R24.7 shows decode is not the bottleneck |
| Upgrade the WebRTC build | Second step, only after traces | Hardware codec exposure, lower receiver-buffer controls, codec preference reality | Build churn without stage timing may swap binaries while preserving the same latency source | R24.7 points to decode or receiver buffering and the newer build exposes the needed control |
| VideoToolbox plus QUIC/WebTransport/MoQ | Prototype only after WebRTC is measured as the problem | Full ownership of jitter buffer, pacing, migration, and codec path | Reimplements loss recovery and pacing before proving WebRTC transport is the bottleneck | R24.9 ADR plus prototype beats tuned WebRTC on the same trace |
| Code-aware crisp-text overlay | Captured, not active | Separates text legibility from video codec quality | Adds a second rendering model and risks drifting from the real desktop | Revisit only if text crispness remains a steady-state v0 friction after media latency is acceptable |

### Rejected For Now

- A direct transport overhaul before instrumentation. Rejected because the observed symptom can come from software decode, receiver buffering, or render scheduling. Revisit after R24.7.
- More aggressive scroll-profile tuning without codec verification. Rejected because the latest VP9 temporal-layer work may be inert if the client negotiates H.264. Revisit after R24.6.
- A second parallel low-quality video stream kept warm. Rejected because it pays continuous encode / bandwidth cost and complicates sync. Revisit only if single-stream profile switching cannot react fast enough after measurement.

## Promotion log

```
D24.1     2026-06-16  committed   client cursor prediction overlay for zero-latency pointer feedback
D24.2     2026-06-16  committed   host cursor seed plus held-position integration fixed at-rest drift
D24.3     2026-06-16  committed   host cursor glyph push and client mirrored cursor overlay
D24.4     2026-06-16  committed   scroll interaction hint toggles low-latency sender profile
D24.5     2026-06-16  committed   scroll acceleration, bitrate cap, and temporal-layer tuning landed
R24.6     pending     pending     verify actual negotiated codec and run H.264 versus VP9 scroll A/B
R24.7     pending     pending     add stage-latency probes across capture, encode, transport, decode, render
R24.8     pending     pending     decide WebRTC build upgrade only if measurements point there
R24.9     pending     pending     gate custom VideoToolbox plus QUIC/WebTransport/MoQ prototype on measured WebRTC bottleneck
```
