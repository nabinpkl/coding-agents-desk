---
status: proposed
date: 2026-06-28
refines:
  - ADR-0027
  - ADR-0028
  - ADR-0029
---

# Adaptive media quality ladder

## Context and Problem Statement

ADR-0027 added bitrate adaptation, ADR-0028 added selective resend, and ADR-0029 added a frame-rate survival rung. That still left resolution as a separate deferred lever, even though slow-link byte pressure is the product of bitrate, cadence, and pixels. The first implementation also logged host cadence pressure and stale in-flight recovery without making those signals load-bearing in the policy, so slow LTE could stay at full-resolution, 30 fps, mostly changing bitrate while motion froze. The media path needs one host-owned policy that chooses bitrate, frame rate, and capture resolution together from packet repair, frame expiry, keyframe fallback, ACK age, host production cadence, and backpressure recovery. Scope: `MediaQualityController`, `QuicSessionHostMediaState`, `QuicSessionHostMediaTransport`, `ScreenCaptureKitFrameSource`, and the client video decoder's resolution-change guard.

## Decision Drivers

- Keep the quality policy host-owned; the client reports observations, not desired quality. A client setting may disable the adaptive ladder entirely for user control, but it must not choose a rung.
- Avoid a bolt-on resolution fallback. Bitrate, cadence, and pixels are one adaptive target.
- Smoothness is the first priority on constrained paths. Full-resolution text is allowed only while host production cadence is healthy.
- High-latency links are not automatically bad. Queue age alone should hold; queue age plus bad cadence, loss, expiry, or repair pressure should downshift.
- A resolution change is a stream sync point: restart capture, force a keyframe, and discard stale pending capture/encode state.
- Stale host in-flight recovery is not decoder recovery. It reopens admission and feeds quality pressure, but it does not force a keyframe by itself.

## Considered Options

- **Option A**: Keep ADR-0029 and add a separate resolution fallback once fps reaches the floor.
- **Option B**: Replace the bitrate/FPS controller with one fixed-rung media-quality controller.
- **Option C**: Let the client request rungs from observed render quality.

## Decision Outcome

Chose **Option B**. Option A is rejected because it keeps three independent levers that can fight each other, for example lower fps while retaining oversized frames. Option C is rejected because it splits policy ownership across peers and turns client render symptoms into quality commands. The host already sees send admission, ACK age, keyframe requests, and client link-health reports, so one host controller can choose a coherent target and apply it atomically.

The controller consumes one observation input per window: packet results, ACK p50/p95/max/count, host production actual fps and max send gap, in-flight byte/frame counts, oldest in-flight age, and stale recovery count. The same controller derives the logged pressure classes and the policy decision, so diagnostics cannot drift from behavior. The phone exposes an on/off setting for this policy; off pins the host video target to native bitrate/FPS/resolution while leaving packet repair and backpressure active.

Pressure classes:

- `lossPressure`: frame expiry, keyframe fallback, or resend pressure.
- `queuePressure`: ACK p95 at or above the downshift threshold.
- `cadencePressure`: host production FPS far below target or max send gap above the cadence threshold.
- `stalePressure`: stale in-flight recovery reopened admission.
- `freezePressure`: max send gap around one second or actual FPS collapsed to the freeze floor.

Downshift policy:

- Queue pressure alone holds.
- Loss pressure spends bitrate first while cadence is acceptable, then steps into capacity rungs.
- Sustained cadence pressure steps into capacity rungs even without packet loss.
- Queue pressure plus cadence pressure steps into capacity rungs immediately.
- Stale pressure steps into capacity rungs immediately.
- Freeze pressure skips bitrate-only loss control and enters a capacity rung.
- If survival still freezes or triggers stale recovery, the controller enters an emergency rung: lower capture scale, lower FPS, and lower bitrate. The current defaults are `0.33`, `6fps`, and `180kbps`.

Recovery is deliberately conservative, but it is measured as production-backed clean time rather than raw link-health window count. Only windows with host production summaries can add recovery credit. Link-only windows with no loss, no stale recovery, and acceptable ACK age hold existing recovery credit instead of erasing it, because production summaries and link-health reports are not guaranteed to arrive on the same cadence. Recovery still requires ACK samples and clean production: no expiry, no stale recovery, ACK p95 below the hold threshold, actual FPS close to target, and max send gap below the recovery smoothness threshold. Production-backed FPS or gap failures reset recovery credit.

Recovery is staged by axis. The controller raises bitrate first while holding capture resolution and FPS. It then probes the next rung's resolution at the old FPS, waits through a bounded transition warmup window caused by ScreenCaptureKit restart and the forced keyframe, and requires clean production before that resolution becomes the stable target. Only after the higher resolution is stable does the controller probe the next FPS. This keeps the first post-restart keyframe burst from being misclassified as steady-state failure and prevents a failed FPS probe from discarding a resolution that already proved stable.

For example, emergency recovery proceeds as `0.33 / 6fps / 180kbps`, then bitrate rises to `300kbps`, then resolution probes at `0.5 / 6fps / 300kbps`, then FPS probes at `0.5 / 10fps / 300kbps`. The same axis order applies to later rung promotions.

Each resolution or FPS promotion is a recovery probe. If cadence or freeze pressure returns after transition warmup, the controller rolls back to the previous stable target for that probe axis instead of generically downshifting. Resolution-probe rollback returns to the prior lower resolution. FPS-probe rollback lowers FPS while preserving the stable resolution. Loss, frame expiry, keyframe fallback, or stale in-flight recovery are still load-bearing during warmup; the warmup window only shields the expected restart/keyframe production gap.

Diagnostics report the recovery accumulator and blocker on every quality window: `recoveryCleanMs`, `requiredRecoveryMs`, `recoveryBlocker`, `recoveryPhase`, `recoveryProbeAxis`, `recoveryWarmupWindows`, `recoveryProbeWindows`, and the stable target fields. Blocker reasons include `recovery-wait-no-production`, `recovery-wait-no-ack`, `recovery-wait-ack`, `recovery-wait-fps`, `recovery-wait-gap`, `transition-warmup`, `probe-resolution-pressure`, and `probe-fps-pressure`.

Keyframe recovery is reason-scoped. Resolution changes and explicit client keyframe requests force keyframes. Client requests are coalesced while a keyframe is already in flight. Stale admission recovery resets host backpressure and records `stalePressure`, but it does not force a large keyframe, because repeated recovery keyframes can become the freeze source on constrained paths.

### Consequences

- Good, because capacity failures degrade through readable rungs instead of freezing or producing fewer oversized full-resolution frames.
- Good, because the same heuristic works on LTE, weak Wi-Fi, tailnet path changes, or any other constrained path.
- Bad, because capture resolution changes restart ScreenCaptureKit and force a keyframe, which is visible as a quality step.
- Neutral, because the wire protocol stays at version 3; existing media frame headers already carry frame dimensions.

### Confirmation

Pure controller tests assert the downshift order, latency-hold behavior, cadence-pressure capacity shifts, freeze-pressure capacity shifts, stale-pressure capacity shifts, emergency entry, production-backed recovery, neutral handling for link-only windows without production summaries, recovery-blocker diagnostics, staged bitrate-resolution-FPS recovery, transition warmup after resolution restart, resolution-probe rollback, and FPS-only rollback. Host tests assert ACK age is measured from sent-frame time, diagnostics carry the same pressure classes and recovery fields the policy used, stale admission recovery does not force keyframes, explicit client keyframe requests are coalesced while a keyframe is in flight, and resolution changes clear stale admission state. Client tests assert keyframes can resync to new dimensions and mismatched deltas are dropped with a keyframe request.

## Pros and Cons of the Options

### Option A

- Good, because it is a smaller patch over the existing survival rung.
- Bad, because it keeps resolution outside the policy that already owns bitrate and cadence.

### Option B

- Good, because every media-quality decision comes from one target: bitrate, fps, resolution scale, rung, and reason.
- Bad, because replacing the controller touches more host tests and transport wiring at once.

### Option C

- Good, because the client is closest to render symptoms.
- Bad, because the client does not own host capture cost, send admission, or ACK-age history.

## Links

- ADR-0027 congestion-adaptive video for constrained links
- ADR-0028 selective packet resend and bounded keyframe recovery
- ADR-0029 capacity survival rung
