# TASKS: v0 constrained-link video resilience (with adaptive control captured)

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

Archived history:
- `tasks/archive/2026-06-26-v0-retained-scroll-ownership.md` carries the closed retained-scroll / content-tile-cache ledger (R34-R80, TileCache-*), retired by the video-primary pivot (ADR-0026): tiles are demoted to an optional crisp-repair layer, the HEVC datagram carrier is the primary media path.
- Earlier ledgers under `tasks/archive/` cover media-output friction, owned single-surface media, and the first hybrid retained-graphics worktree.

## Position

The video carrier works on fast WiFi and freezes on LTE. The cause is that the `always_video` path is open-loop: the encoder runs at a fixed `AverageBitRate` with no hard ceiling, fires HEVC datagrams with no link feedback, and recovers from loss only by requesting a keyframe, which is larger than the frames the link already could not carry. A second, independent freeze is a wedged `AVSampleBufferDisplayLayer` that never recovers because the recovery decision is written but not wired. Decisions and the option analysis are in ADR-0027. Numbering continues from the archived ledger (which ended at R80), so this iteration starts at R81.

Ordering:

- First land the bounded-open-loop fix (ADR-0027 Option B), because it stops the freeze cheaply and each part is independently correct: a keyframe that cannot burst past the link budget cannot start a collapse spiral, and a wedged decoder that self-heals cannot stay black.
- Encoder hard ceiling comes before the client watchdog only because it is the smaller change and removes the dominant spiral trigger; the two are independent and could land in either order.
- The closed loop (Option C, adaptive bitrate) comes last. It needs the ceiling and the freeze-recovery underneath it as a fail-safe floor, and it is the part that needs device data to tune. Do not start it until Phase 1 and Phase 2 have a throttled-link run behind them.
- NACK/selective resend and FEC stay captured, not started. The repair buffer already computes resend requests but nothing sends or serves them; keyframe-only recovery stays until the adaptive loop is shown to be insufficient.

This is congestion control over the existing ADR-0025 datagram carrier, not a transport change. Chroma stays 4:2:0; it is not a lever (4:4:4 would be worse on a constrained link).

## v0 Phase 0: readiness review and ADR (gate)

Phase goal: pin the open-loop failure shape and lock the decision before code lands.

- [x] R81. ADR `architecture-decisions/0027-congestion-adaptive-video.md`: records the open-loop freeze (no `DataRateLimits`, keyframe-only recovery, unwired `OwnedMediaDisplayQueuePolicy`), rejects static-knob-only (Option A), and commits to Option B now / Option C as target. Status `proposed` until Phase 1 and Phase 2 land.

## v0 Phase 1: encoder hard ceiling (bound the burst)

Phase goal: no produced frame, keyframe included, may burst past the link budget, so loss recovery cannot deepen congestion.

- [ ] R82. In `host/AgentDeskHost/VideoToolboxOwnedMediaEncoder.swift:255` (the `setProperty` block after session create), set `kVTCompressionPropertyKey_DataRateLimits` to a windowed hard cap derived from the target bitrate, alongside the existing `AverageBitRate`. Add `Config.ownedMediaDataRateLimitRatio` (host `Config`, env `AGENTDESK_OWNED_MEDIA_DATA_RATE_LIMIT_RATIO`, default the windowed ceiling at a small multiple of the average) so the cap tracks the bitrate rather than being a second hardcoded literal.
- [ ] R83. Test in `host/AgentDeskHostTests/VideoToolboxOwnedMediaEncoderTests.swift`: asserts the session is created with a non-nil `DataRateLimits` whose window ceiling equals the configured ratio times the average bitrate, and that a forced keyframe encode does not exceed the windowed cap over its interval. Existing encoder tests (keyframe forcing, parameter-set extraction) stay green.

## v0 Phase 2: client freeze recovery (never stay wedged)

Phase goal: a stalled or `.failed` decoder self-heals instead of holding a frozen frame.

- [ ] R84. Wire `OwnedMediaDisplayQueuePolicy.action` (`client/AgentDeskClient/SharedTypes.swift:1568`) into the live render path. In `client/AgentDeskClient/OwnedMediaVideoDecoder.swift`, read `displayLayer.status` / `requiresFlushToResumeDecoding` before enqueue and, when the policy returns `.flushAndRemoveImage`, call `flushAndRemoveImage()` and drop the pending format description so the next frame must be a keyframe. Surface the action to `OwnedMediaVideoSink` so it can request a keyframe.
- [ ] R85. Add a render-stall watchdog in `client/AgentDeskClient/OwnedMediaVideoSink.swift` keyed off `lastRenderUptimeNs`: if no video frame has displayed within `Config.ownedMediaRenderStallMs` (client `Config`, env `AGENTDESK_OWNED_MEDIA_RENDER_STALL_MS`), flush the layer and send one `keyframeRequest` over the carrier (`OwnedMediaTransport.sendVideoControl`), rate-limited so a dead link does not spam requests. The watchdog is independent of `MediaDatagramFrameRepairBuffer`'s deadline, which only fires on packet loss, not on a decoder that stops presenting.
- [ ] R86. Tests: a `OwnedMediaVideoDecoder` unit proving a `.failed` status triggers `flushAndRemoveImage` and forces keyframe-pending state on the next frame; a watchdog unit (against an injected clock) proving a stall past the threshold emits exactly one rate-limited keyframe request and that a resumed frame clears the stall. Extend `client/AgentDeskClientTests/OwnedMediaVideoDecoderTests.swift`.

## v0 Phase 3: closed-loop adaptive bitrate

Phase goal: the stream finds the link's real, moving capacity instead of a fixed nominal bitrate.

Trigger: start only after Phase 1 and Phase 2 have a throttled-link run behind them (R91 baseline). Until then the bounded open loop is the shipping behavior.

- [ ] R87. Define a carrier link-health control message in both `SharedTypes.swift` copies: extend `OwnedMediaControlMessage` (or add a sibling kind) carrying compact client-measured fields (recent loss ratio from `MediaDatagramFrameRepairBuffer`, repaired/expired frame counts, max render-gap ms). Round-trip codec test in both targets.
- [ ] R88. Client: emit the link-health message on a fixed cadence from `client/AgentDeskClient/OwnedMediaTransport.swift`, sourced from the repair buffer's `repairedFrameCount` / `expiredFrames` and the sink's render-gap, reusing `sendVideoControl`. No new connection; it rides the existing host-bound datagram path beside the keyframe request.
- [ ] R89. Host: add a `VideoBitrateController` (new `host/AgentDeskHost/VideoBitrateController.swift`) consuming the link-health message via `OwnedMediaVideoDatagramServer.onControlMessage`, stepping a target bitrate between `Config.ownedMediaBitrateFloorKbps` and the configured ceiling with hysteresis (down fast on loss, up slow on a clean window). Apply it live with `VTSessionSetProperty(AverageBitRate)` + `DataRateLimits` on the running session in `VideoToolboxOwnedMediaEncoder` (no session recreate). Log each step with reason.
- [ ] R90. Tests for `VideoBitrateController`: sustained loss steps the target down to the floor and not below; a clean window recovers it upward under hysteresis (no oscillation on a single good sample); the controller never raises above the configured ceiling. Pure-logic unit, no live encoder.

## v0 Phase 4: constrained-link acceptance

Phase goal: prove the freeze is gone on a real constrained link and the loop tracks it.

- [ ] R91. Run `just check`, then a throttled-link physical run (`just fresh-consoled-run`, with Network Link Conditioner LTE profile or real cellular). Collect host owned-media logs and the attached client console. Accept only if: motion sustains with no render gap beyond the watchdog bound, no permanent freeze across a WiFi-to-LTE transition, keyframe recovery never exceeds the `DataRateLimits` window, and (after Phase 3) the host log shows the bitrate controller stepping down under loss and recovering as the link clears. Classify any remaining blocker as encoder ceiling, decoder recovery, feedback cadence, or controller tuning before the next edit.

---

## v0 adaptive-recovery scope (captured, not started)

Opens only if Phase 3's keyframe-only recovery under the adaptive loop still glitches visibly on a lossy link.

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Selective resend (NACK) | `MediaDatagramFrameRepairBuffer.resendRequests` (already computed, inert) + host `ownedMediaResendRingFrames` | Single-packet loss without a full keyframe | Resend can arrive too late behind newer frames; ring memory and a host serve path are new cost |
| Datagram FEC | RDP/WebRTC UDP recovery | Steady low-rate loss without any round-trip | Parity overhead is paid on every frame, including the common no-loss case |
| Adaptive capture scale-down | `Config.ownedMediaCaptureScaleDown` driven by the controller | Severe links where even floor bitrate at native Retina is too many pixels | A resolution change is a keyframe and a visible sharpness step; needs the same hysteresis as bitrate |

### Alternative arc (rejected for now, captured)

- Static `.env` knobs as the answer (ADR-0027 Option A). Useful as a manual escape hatch on a known-bad link. Rejected as the path because a literal cannot track a mid-session link change and does nothing for the wedged-decoder freeze. Revisit only as documented operator guidance, never as the mechanism.
- Wire NACK before the adaptive loop. Useful because per-packet repair is cheaper than a keyframe. Rejected first because the dominant freeze is congestion collapse, not isolated packet loss; bounding the burst and closing the bitrate loop addresses the cause, and NACK only helps once the link is no longer saturated. Revisit if R91 shows residual single-packet glitches after the loop settles.

---

## Promotion log

```
R34-R80      2026-06-26  archived    retained-scroll / content-tile-cache ledger moved to tasks/archive (retired by ADR-0026 video-primary pivot)
R81          2026-06-26  committed   ADR-0027 drafted: congestion-adaptive video, Option B now / Option C target, static-knob-only rejected
R82-R83      pending     pending     encoder DataRateLimits hard ceiling + window-cap test
R84-R86      pending     pending     client freeze recovery: wire OwnedMediaDisplayQueuePolicy, render-stall watchdog, decoder/watchdog tests
R87-R90      pending     pending     closed-loop adaptive bitrate: link-health control message, client emit, host VideoBitrateController, controller tests
R91          pending     pending     constrained-link physical acceptance (throttled / LTE) and blocker classification
```
