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

- [x] D82. In `host/AgentDeskHost/VideoToolboxOwnedMediaEncoder.swift` (the `setProperty` block after session create), set `kVTCompressionPropertyKey_DataRateLimits` to a one-second windowed hard cap, alongside the existing `AverageBitRate`. `Config.ownedMediaDataRateLimitRatio` (env `AGENTDESK_OWNED_MEDIA_DATA_RATE_LIMIT_RATIO`, default 1.5) threads through `OwnedMediaEncodingConfiguration` so the cap tracks the bitrate. Cap and window logged on the session line for R91.
- [x] D83. Tests in `host/AgentDeskHostTests/VideoToolboxOwnedMediaEncoderTests.swift`: `testDataRateLimitsCeilingTracksBitrateAndRatio` asserts the window ceiling equals ratio times the average byte-rate (the value set on the session); `testForcedKeyframeStaysWithinDataRateCap` encodes a forced keyframe plus one interval and asserts the bytes stay within the window cap. Existing encoder tests stay green.

## v0 Phase 2: client freeze recovery (never stay wedged)

Phase goal: a stalled or `.failed` decoder self-heals instead of holding a frozen frame.

- [x] D84. Wired `OwnedMediaDisplayQueuePolicy.action` into the live render path. `OwnedMediaVideoDecoder` reads `displayStatus` / `requiresFlushToResumeDecoding` (added to `OwnedMediaVideoEnqueuing`) before enqueue; on `.flushAndRemoveImage` it blanks the layer and drops the format description so a keyframe must resync. A delta on a wedged layer returns the new `.recoveredRequestKeyframe`, which `OwnedMediaVideoSink` turns into a keyframe request; a keyframe resyncs in place.
- [x] D85. Render-stall watchdog `OwnedMediaRenderStallWatchdog` in `OwnedMediaVideoSink.swift`, driven by a main-queue `DispatchSourceTimer`. It fires only while frames are arriving (host sending) but none have enqueued for `Config.ownedMediaRenderStallMs` (env `AGENTDESK_OWNED_MEDIA_RENDER_STALL_MS`, default 1000), so a quiet host never triggers it. On fire it flushes (keeps last image), requires a keyframe, and sends one rate-limited request via a handler the `OwnedGraphicsTransport` installs (`sendVideoControl`). Independent of the repair-buffer deadline, which only fires on packet loss.
- [x] D86. Tests in `client/AgentDeskClientTests/OwnedMediaVideoDecoderTests.swift`: wedged-layer delta recovers, blanks once (not flush), drops the delta, and stays keyframe-pending; wedged-layer keyframe resyncs in place without a second flush; watchdog fires when arriving-but-not-enqueuing, stays quiet for a quiet host, respects the rate limit, and requires a prior enqueue. All six pass on the simulator client suite.

## v0 Phase 3: closed-loop adaptive bitrate

Phase goal: the stream finds the link's real, moving capacity instead of a fixed nominal bitrate.

Trigger: start only after Phase 1 and Phase 2 have a throttled-link run behind them (R91 baseline). Until then the bounded open loop is the shipping behavior.

- [x] D87. Added a `.linkHealth` kind plus `linkHealthCompletedFrames` / `linkHealthExpiredFrames` (window counts) to `OwnedMediaControlMessage` in both `SharedTypes.swift` copies. Round-trip tests in both targets (host `MediaDatagramCarrierTests`, client `OwnedMediaFrameRepairBufferTests`). Render-gap was dropped from the message; the repair-buffer loss counts are the primary signal and avoid a sink-to-transport hop.
- [x] D88. Client emits the link-health message every `Config.ownedMediaLinkHealthIntervalMs` (env, default 500) from `OwnedMediaTransport.swift`, tallying `result.completedFrames` / `result.expiredFrames` in the datagram rx handler and resetting per window. Rides the existing `sendVideoControl` datagram path; starts/stops with the carrier keepalive.
- [x] D89. `VideoBitrateController` + `VideoBitrateControllerConfig` (co-located in `VideoToolboxOwnedMediaEncoder.swift` to avoid new-file pbxproj wiring) consumed via `OwnedMediaVideoDatagramServer.onControlMessage` -> `OwnedMediaTransport.handleLinkHealth`. Steps the target between `ownedMediaBitrateFloorKbps` and the ceiling (multiplicative down 0.7 fast / up 1.15 after a clean streak), applied live via `VideoToolboxOwnedMediaEncoder.updateBitrate` (`VTSessionSetProperty` AverageBitRate + DataRateLimits, no recreate; the encoder now tracks a mutable `currentBitrateKbps`). Each step logged with reason.
- [x] D90. Five `VideoBitrateController` tests: sustained loss converges to the floor and not below; three clean windows do not raise but the fourth does (hysteresis); clean windows never exceed the ceiling; an idle window holds. Pure-logic, no live encoder.
- [x] D-default. Lowered `Config.ownedMediaBitrateKbps` default 8000 -> 2500 (the controller ceiling), per the device finding that a Retina text keyframe is content-bound ~140KB and 8000 bought no text quality. Removed the temporary `.env` override.

## v0 Phase 4: constrained-link acceptance

Phase goal: prove the freeze is gone on a real constrained link and the loop tracks it.

- [x] R91. Throttled-LTE device run (`just fresh-consoled-run-dev`) passed. No permanent freeze across WiFi-to-LTE; the controller drove the full cycle (2500 -> 986 kbps under loss, recovering 986 -> 2500 in steps, 7 down / 14 up); `dataRateCapBytes` tracked each step; loss-driven keyframe-requests fell to 8 per session (vs 16-19 at a fixed bitrate). ADR-0027 accepted. Remaining open item is tuning, not correctness: `lossDownPermille=50` trips a down-step on a single lost frame in ~19, so the rate is slightly twitchy though it recovers fast; revisit the threshold with more device data.

## v0 Phase 5: selective resend (ADR-0028)

Phase goal: stop the LTE keyframe-storm. A single dropped packet is repaired by re-sending that packet, not by forcing a full keyframe that is itself too large to cross the lossy link.

Trigger: R91 proved keyframe-only recovery insufficient on LTE. The host log showed scroll keyframes at 230-288 packets and a recovery keyframe-storm (frames 387/391 double-request, two 240 KB keyframes back to back). The repair buffer already computes `resendRequests` and the wire (`.packetResendRequest` + `packetIndexes`) and host `OwnedMediaResendRing` exist but are inert; this phase wires them. See ADR-0028.

- [x] D92. Activated NACK end to end. Client `OwnedMediaTransport.handleVideoDatagram` sends each `result.resendRequests` entry as a `.packetResendRequest` (frameId + missing `packetIndexes`). Host remembers every sent frame's packets in `OwnedMediaResendRing` at the datagram send site, and the datagram control handler (`handlePacketResendRequest`) serves a request by re-emitting the named indexes from the ring (capped by `ownedMediaMaxResendPackets`). Purely additive and loss-triggered, so a clean link sends and serves nothing. The pure-logic pieces were already covered (`MediaDatagramCarrierTests`: ring serve/miss/evict + `.packetResendRequest` round-trip with `packetIndexes`); this wired the dormant scaffolding into the transport. Host 243 + client 115 tests green.
- [x] D93. In-flight keyframe-request suppression on the client expiry path, so a loss burst cannot fan out into a keyframe storm before resend lands. Bounded by `Config.ownedMediaKeyframeRequestMinGapMs` (env, default 300ms ~1 LTE RTT) so a genuinely lost keyframe still re-requests after the gap. Complements D92; keyframe recovery stays the past-deadline fallback.
- [ ] R94. Throttled-LTE device validation gate (`just fresh-consoled-run-dev`) after D95. Acceptance: host log shows resends served, loss-driven keyframe-requests per session below the R91 baseline of 8, and the steppy/lag easing with no WiFi regression. Flip ADR-0028 to accepted on a pass.
- [x] D95. Fixed the first R94 failure shape. The 2026-06-26 device run showed many `resend-miss` lines, zero `resend-served`, and continued keyframe fallback, so the first NACK wiring was not yet serving packets on LTE. `host/AgentDeskHost/Config.swift` raises `ownedMediaResendRingFrames` from 8 to 240 so the host keeps enough frame history for LTE request latency, `.env.example` documents the default, and `client/AgentDeskClient/OwnedMediaFrameRepairBuffer.swift` now expires/evicts locally dropped frames before emitting resend requests. Test `client/AgentDeskClientTests/OwnedMediaFrameRepairBufferTests.swift::testTrackedLimitEvictsBeforeRequestingResend` pins the no-hopeless-NACK order. `just check` and `just sim-test` passed.

## v0 Phase 6: capacity-driven cadence (ADR-0029)

Phase goal: convert the genuinely-slow-link freeze into low-fps-but-alive. When bitrate alone cannot fit the pipe, spend cadence. The slow-link freeze is a capacity problem (bytes do not fit), not a loss problem (which NACK and the bitrate loop already handle), so the lever is a new degree of freedom, not more loss recovery.

Trigger: the post-NACK device feedback was that NACK works but a genuinely slow connection still freezes (expected, capacity-bound). fps is the cheapest capacity lever, the produce-cadence gate (`MotionGovernor.policy.minFrameIntervalNs`) already exists. Resolution downscale (higher leverage, but a session recreate plus untested client resync) is deferred. See ADR-0029.

- [x] D96. `VideoBitrateController` gains an fps axis (`targetFps`, `fpsCeiling`/`fpsFloor`/`fpsDownStep`/`fpsUpStep` in config). fps steps down only once `targetKbps` is pinned at the floor and the window is still lossy, and recovers only after bitrate is restored to the ceiling (recovery order is a documented policy choice). `VideoToolboxOwnedMediaEncoder.updateExpectedFrameRate` retargets the live session (no recreate) so bit allocation tracks cadence. The produce loop folds a capacity interval (`1e9 / targetFps`) into the cadence gate via `max(governor, capacity)`, dormant at ceiling fps so the validated path is unchanged. `handleLinkHealth` logs `fps-step`. Config knobs `ownedMediaFpsFloor` (10) / `ownedMediaFpsDownStep` (0.7) / `ownedMediaFpsUpStep` (1.3), documented in `.env.example`. Two new `VideoBitrateController` tests (cadence steps down only after bitrate floor and not below; recovers only after bitrate ceiling and not above); host suite green.
- [ ] R97. Genuinely-slow-link device validation gate (`just fresh-consoled-run-dev`). Acceptance: host log shows `fps-step` rungs down keeping the stream alive (no freeze) and stepping back up as the link clears, with no change on a link that has headroom. Flip ADR-0029 to accepted on a pass.

---

## v0 adaptive-recovery scope (captured, not started)

Opens only if Phase 3's keyframe-only recovery under the adaptive loop still glitches visibly on a lossy link.

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Selective resend (NACK) | PROMOTED to ADR-0028 / Phase 5 (R92): `MediaDatagramFrameRepairBuffer.resendRequests` wired to `.packetResendRequest` + host `OwnedMediaResendRing` | Single-packet loss without a full keyframe | Resend can arrive too late behind newer frames; ring memory and a host serve path are new cost |
| Datagram FEC | RDP-style UDP loss recovery | Steady low-rate loss without any round-trip | Parity overhead is paid on every frame, including the common no-loss case |
| Adaptive capture scale-down | `Config.ownedMediaCaptureScaleDown` driven by the controller | Severe links where even floor bitrate at native Retina is too many pixels | A resolution change is a keyframe and a visible sharpness step; needs the same hysteresis as bitrate |

### Alternative arc (rejected for now, captured)

- Static `.env` knobs as the answer (ADR-0027 Option A). Useful as a manual escape hatch on a known-bad link. Rejected as the path because a literal cannot track a mid-session link change and does nothing for the wedged-decoder freeze. Revisit only as documented operator guidance, never as the mechanism.
- Wire NACK before the adaptive loop. Useful because per-packet repair is cheaper than a keyframe. Rejected first because the dominant freeze is congestion collapse, not isolated packet loss; bounding the burst and closing the bitrate loop addresses the cause, and NACK only helps once the link is no longer saturated. Revisit if R91 shows residual single-packet glitches after the loop settles.

---

## Promotion log

```
R34-R80      2026-06-26  archived    retained-scroll / content-tile-cache ledger moved to tasks/archive (retired by ADR-0026 video-primary pivot)
R81          2026-06-26  committed   ADR-0027 drafted: congestion-adaptive video, Option B now / Option C target, static-knob-only rejected
D82-D83      2026-06-26  committed   encoder DataRateLimits hard ceiling (ratio knob, 1s window) + ceiling-contract and within-cap tests
D84-D86      2026-06-26  committed   client freeze recovery: wedged-layer recovery wired into decoder, render-stall watchdog with keyframe-request handler, six decoder/watchdog tests green on sim
R82-R86      2026-06-26  device      throttled-LTE run: cap applied (dataRateCapBytes live), no permanent freeze, recovery fired; motion-delta bursts confirmed as the remaining choppiness, lowering bitrate kept text crisp
D87-D90      2026-06-26  committed   closed-loop adaptive bitrate: .linkHealth wire message + round-trips, client per-window emit, host VideoBitrateController applied live via updateBitrate, 5 controller tests; default bitrate 8000->2500
R91          2026-06-26  done        throttled-LTE run passed: full down-up controller cycle (2500<->986), cap tracked, keyframe-requests 8/session, no permanent freeze; ADR-0027 accepted
LogFix       2026-06-26  committed   video-sent log shows the live adapted bitrate, not the static ceiling
R92-R94      2026-06-26  planned     ADR-0028 drafted: selective resend (NACK) promoted from captured non-goal on R91 evidence (LTE keyframe-storm); wire dormant resend scaffolding, add in-flight keyframe suppression
D92-D93      2026-06-26  committed   NACK wired end to end (client sends resendRequests, host remembers + serves from OwnedMediaResendRing) + expiry-path keyframe-request min-gap suppression; host 243 + client 115 green
R94          2026-06-26  device-failed first validation produced resend-miss only (0 resend-served) and continued keyframe fallback; keep ADR-0028 proposed
D95          2026-06-26  committed   extend host resend ring to 240 frames and make client evict/drop before NACKing; host 243 + client 115 green
D96          2026-06-26  committed   ADR-0029: capacity-driven cadence axis on VideoBitrateController (fps drops once bitrate pinned at floor + losing, recovers after ceiling); produce-gate folds capacity interval, live updateExpectedFrameRate, +2 controller tests; host green
R97          2026-06-26  planned     genuinely-slow-link device gate for the fps cadence lever; flip ADR-0029 accepted on a pass
```
