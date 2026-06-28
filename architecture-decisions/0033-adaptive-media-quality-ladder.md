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

ADR-0027 added bitrate adaptation, ADR-0028 added selective resend, and ADR-0029 added a frame-rate survival rung. That still left resolution as a separate deferred lever, even though slow-link byte pressure is the product of bitrate, cadence, and pixels. The media path needs one host-owned policy that chooses bitrate, frame rate, and capture resolution together from the same observations: repaired loss, expired frames, keyframe fallback, and host-derived frame ACK age. Scope: `MediaQualityController`, `QuicSessionHostMediaState`, `QuicSessionHostMediaTransport`, `ScreenCaptureKitFrameSource`, and the client video decoder's resolution-change guard.

## Decision Drivers

- Keep the quality policy host-owned; the client reports observations, not desired quality.
- Avoid a bolt-on resolution fallback. Bitrate, cadence, and pixels are one adaptive target.
- High-latency links are not automatically bad. Queue age alone should hold; queue age plus loss or expiry should downshift.
- A resolution change is a stream sync point: restart capture, force a keyframe, and discard stale pending capture/encode state.

## Considered Options

- **Option A**: Keep ADR-0029 and add a separate resolution fallback once fps reaches the floor.
- **Option B**: Replace the bitrate/FPS controller with one fixed-rung media-quality controller.
- **Option C**: Let the client request rungs from observed render quality.

## Decision Outcome

Chose **Option B**. Option A is rejected because it keeps three independent levers that can fight each other, for example lower fps while retaining oversized frames. Option C is rejected because it splits policy ownership across peers and turns client render symptoms into quality commands. The host already sees send admission, ACK age, keyframe requests, and client link-health reports, so one host controller can choose a coherent target and apply it atomically.

### Consequences

- Good, because capacity failures degrade through readable rungs instead of freezing or producing fewer oversized frames.
- Good, because the same heuristic works on LTE, weak Wi-Fi, tailnet path changes, or any other constrained path.
- Bad, because capture resolution changes restart ScreenCaptureKit and force a keyframe, which is visible as a quality step.
- Neutral, because the wire protocol stays at version 3; existing media frame headers already carry frame dimensions.

### Confirmation

Pure controller tests assert the downshift order, latency-hold behavior, and conservative recovery. Host tests assert ACK age is measured from sent-frame time and resolution changes clear stale admission state. Client tests assert keyframes can resync to new dimensions and mismatched deltas are dropped with a keyframe request.

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
