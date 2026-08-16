---
status: accepted
date: 2026-08-16
supersedes: ADR-0033 (rung ladder), ADR-0098 (rung-quantized descent targets)
---

# The quality target is a number, not a name

## Context and Problem Statement

The adaptive media-quality controller (ADR-0033) chose targets from a fixed ladder of named
rungs (native, lossControl, capacity1, capacity2, survival, emergency), each pairing a bitrate
with an fps. Measured on LTE (2026-08-15, after the ADR-0098/0100 fixes and the cb74f8bf floor
work), the residual failures were all quantization artifacts of that ladder:

- **No step below the bottom.** `at-emergency-floor` fired in 126 windows and
  `queue-bloat-hold` in 116 of one session: the queue-bloat detector kept demanding a descent
  the ladder could not express, so a standing 1-2.6s queue (rttInflation 10-32x) persisted at
  the floor.
- **No step between rungs.** capacity1 asked 650kbps while its own 24fps needed ~916kbps of
  the measured content (p50 delta 4.8KB, mean 7.7KB) — 1.3-1.4x oversubscribed — and a link
  whose true capacity sat between two rungs was representable by neither, so `sentKbps` ran
  p90 359 against a link delivering 186.
- **Rung fps was configured, not derived**, so every rung's cadence had to be re-tuned by
  hand whenever the content's frame cost drifted (the exact scar cb74f8bf fixed once, for one
  rung, by measurement).

The encoder side was already continuous: `AverageBitRate`/`DataRateLimits` are cheap live
property sets, and ADR-0100 removed resolution — the one axis whose change costs an IDR —
from adaptation entirely. The ladder existed only inside `MediaQualityController`.

## Decision Drivers

- The controller must be able to land where the link measurably is, not at the nearest name.
- A target must carry its cadence in bytes by construction (cb74f8bf, generalized).
- ADR-0098's descent-signal ordering and reason-code telemetry must survive unchanged — that
  legibility is what made this arc debuggable.
- The measurement loop must never starve itself (a 0 target stops acks, which stops the
  delivery estimator and RTT tracker, which blinds the controller).

## Considered Options

- **Option A**: One continuous bitrate target; fps derived from bitrate through the measured
  frame cost.
- **Option B**: Keep the ladder, add lower rungs and retune budgets against measurement.
- **Option C**: Keep the ladder, make only the emergency rung's bitrate continuous.

## Decision Outcome

Chose **Option A**. B and C both keep the structural defect (a finite set of named points on
a continuous axis) and the hand-tuned fps pairings that drift from content cost; B had already
been done twice (ADR-0098 budgets, cb74f8bf floor) and drifted twice.

The shape, in `MediaQualityController`:

- `targetKbps` moves continuously in `[floorKbps=60, ceilingKbps=2500]`. The floor is a
  heartbeat — roughly one mean-cost delta frame per second — not 0, per the fourth driver.
- **Descent** (`descend(reason:deliveredBytesPerSecond:)`), same trigger order and streak
  gates as ADR-0098 (stalled → stale → shortfall → queue-bloat → loss → freeze →
  queue+cadence → cadence): `next = min(target × downStep, delivered × deliverySnapRatio)`,
  floored. The snap term lands ONE confirmed descent at the measured delivery rate times a
  drain margin (0.85) instead of walking steps toward it; with no measurement only the blind
  multiplicative step (0.7) applies — unknown is not zero.
- **Climb** keeps the clean-credit machinery verbatim (raiseCleanWindows of clean or idle
  link time per step) and moves `target × upStep` (1.15) toward the ceiling.
- **fps is derived, never chosen**: `fps = clamp(kbps / (8 × frameBytesTarget) × 1000, 1, 30)`
  where `frameBytesTarget = (delta-frame EWMA ?? seed 10KB) × 1.3 headroom`. The EWMA is
  measured live from every sent delta frame (`deltaFrameBytesEwma`, commit 7d5969c6).
  Keyframes are excluded: they are session-start events (ADR-0100).
- **lossControl is folded in.** The old rung cut bitrate while holding 30fps (more, smaller
  frames); loss is now just another descent trigger, so a lossy link gets fewer frames at the
  content's measured size. Deliberate behavior change.
- Deleted with the rungs: the fps probe machinery (probe axis, probe windows, rollback,
  stableTarget) and the transition warmup. Probes existed because raising fps was a gamble;
  a derived fps rises only because bitrate already earned its climb, and overreach is
  corrected within two windows by a descent that snaps to measurement.
- The link-quality prior (ADR-0087) keeps its numbers as kbps (minimal→400, moderate→650);
  the ADR-0090 resume pin and the manual fixed pin carry unchanged — they were always just
  bitrate/fps/scale. Reasons survive verbatim except `at-emergency-floor`/`at-survival-floor`
  → `at-floor`, and `at-rung-ceiling` disappears (only the ceiling is a ceiling now).

### Consequences

- Good, because a confirmed descent lands at the link's measured rate in one move, and the
  target can keep descending below the old 90kbps bottom until the queue actually drains.
- Good, because cadence tracks content cost automatically: cheap frames raise fps toward 30,
  expensive frames lower it, with no per-rung tuning left to drift.
- Good, because ~200 lines of rung/probe/warmup machinery and eight config knobs are gone.
- Bad, because loss no longer preserves cadence (fewer frames instead of smaller ones) — if
  lossy-link smoothness regresses, the lever is a loss-triggered frame-size reduction, not a
  rung.
- Bad, because with no measured frames the seed budget (13KB effective) derives 24fps at the
  2500 ceiling rather than 30; the first second of real content corrects it via the EWMA.
- Neutral, because logs now name the two inputs each decision was computed from
  (`deliveredKbps=`, `frameBytesTarget=`) instead of a rung id.

### Confirmation

`mediaQualityTargetApplied` on a bloated LTE link shows kbps gliding (each descent explained
by its `deliveredKbps`), `at-floor` only near 60kbps, and `sentKbps` p90 within ~1.2x of
delivered p90 (was 2x). Unit gates: `MediaDeliveryShortfallTests` (snap and no-cascade),
`MediaDeliveryDescentTests` (floor walk, at-floor), `VideoToolboxOwnedMediaEncoderTests`
(derived-cadence walk, config normalization), `MediaFrameCostTests` (EWMA).

## Pros and Cons of the Options

- **A**: Pro — structural fix, measurement-driven, less code. Con — two behavior changes
  (loss cadence, seed-budget ceiling fps) accepted and named above.
- **B**: Pro — smallest diff. Con — keeps quantization and hand-paired fps; already failed
  twice by drift.
- **C**: Pro — fixes the measured floor bloat only. Con — leaves the between-rung mismatch
  and two control regimes in one controller.
