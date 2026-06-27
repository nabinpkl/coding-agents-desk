---
status: proposed
date: 2026-06-26
refines: ADR-0026
---

# Congestion-adaptive video for constrained links

## Context and Problem Statement

The `always_video` carrier (ADR-0025, made default by ADR-0026) is open-loop. The encoder runs at a fixed `AverageBitRate` (`Config.ownedMediaBitrateKbps`, default 8000) set once in `VideoToolboxOwnedMediaEncoder.ensureSession` and never adapts to the link; it sets no `DataRateLimits`, so a single full-screen keyframe bursts far past the average. The carrier fires HEVC datagrams as fast as the encoder emits them with no link feedback (the ack/pacer backpressure in `OwnedMediaTransport` belongs to the reliable tile channel, which carries nothing under `always_video`). On fast WiFi this is fine; on LTE the link cannot carry it, datagrams drop, the client requests a keyframe (`OwnedMediaTransport.swift`, the only recovery path), and the keyframe is even larger, deepening the congestion: a collapse spiral that ends in a frozen frame. A second freeze mode is independent: the client `AVSampleBufferDisplayLayer` can wedge into `.failed` / `requiresFlushToResumeDecoding` after sustained corrupt input, and the recovery decision that exists (`OwnedMediaDisplayQueuePolicy` in `SharedTypes.swift`) is not wired into the live render path (`OwnedMediaVideoSink.renderOwnedVideoFrame`), so a wedged layer never recovers. Scope: `VideoToolboxOwnedMediaEncoder`, `OwnedMediaTransport` (host + client), `OwnedMediaVideoDatagramServer`, `OwnedMediaVideoSink`, `OwnedMediaVideoDecoder`, `MediaDatagramFrameRepairBuffer`, `Config` (both ends).

Chroma is not a lever here: the carrier already captures and encodes 4:2:0 (`Config.ownedMediaChroma` default `yuv420`), the bandwidth-friendly setting; 4:4:4 is opt-in and would be worse on a constrained link.

## Decision Drivers

- Preserve the validated behavior on a good link: smooth, responsive, cheap at rest.
- Fail safe, not frozen, on a constrained or lossy link. Degrade image and cadence; never wedge.
- Recovery load must not exceed link capacity. A keyframe sent to recover from loss cannot itself be the thing that saturates the link.
- Single source of truth for the link estimate. The "right" bitrate for a link is not a per-machine `.env` literal, and it must track a link that changes mid-session (WiFi to LTE handoff).
- Reversibility and minimal first step. Prefer the smallest change that stops the freeze before committing to a full control loop.

## Considered Options

- **Option A**: Static knobs only. Document `AGENTDESK_OWNED_MEDIA_BITRATE_KBPS`, `_CAPTURE_SCALE_DOWN`, `_FPS`, `_KEYFRAME_INTERVAL_FRAMES` and tell the operator to lower them for LTE.
- **Option B**: Bounded open loop. Add an encoder hard ceiling (`DataRateLimits`) so no frame, keyframe included, bursts past the link budget, plus client freeze recovery (wire `OwnedMediaDisplayQueuePolicy`; add a render-stall watchdog that flushes and requests a keyframe). Nominal bitrate stays fixed.
- **Option C**: Closed loop. Layer adaptive bitrate on top of B: the client reports a link-health signal (loss, repair rate, render-gap) back over the carrier, and a host rate controller steps the encoder bitrate up and down with hysteresis.

## Decision Outcome

Chose **Option C as the target, reached incrementally through Option B**. Option A is rejected outright: a static literal cannot track a link that changes mid-session, it pushes link policy into per-machine `.env` against single-source-of-truth, and it does nothing for the wedged-decoder freeze, which is half the problem. Option B is the first landing because the hard ceiling plus freeze recovery stops the LTE freeze cheaply and is independently correct (a keyframe that cannot exceed the budget cannot start a spiral; a wedged layer that self-heals cannot stay frozen). Option C is the destination because only a feedback loop finds the link's real, moving capacity instead of a guessed constant; B caps the worst case but still wastes headroom on a fast link and still oversends on a slow one between keyframes. C is gated behind B so the expensive, tuning-heavy part is added against a base that already fails safe.

### Consequences

- Good, because a constrained link degrades (softer image, lower cadence) instead of freezing, and a fast link keeps the validated quality.
- Good, because keyframe recovery is bounded by the same ceiling, so the recovery mechanism can no longer be the cause of the freeze it is recovering from.
- Good, because the wedged decoder self-heals through the already-written `OwnedMediaDisplayQueuePolicy` instead of staying black.
- Bad, because the closed loop adds a client-to-host feedback datagram and host-side rate state: more moving parts and a tuning surface (step sizes, hysteresis, floor and ceiling).
- Bad, because an over-eager downshift can briefly soften text on a transient dip; mitigated by hysteresis and a quality floor.
- Neutral, because chroma stays 4:2:0 and the datagram carrier mechanism itself is unchanged; this adds a control layer over ADR-0025's transport, it does not replace it.

### Confirmation

Accepted-and-executed is observable in three places. First, a unit test asserts the encoder sets `DataRateLimits` (not only `AverageBitRate`), and that the live sink consults `OwnedMediaDisplayQueuePolicy.action` on a `.failed` / `requiresFlush` status. Second, a deliberately throttled-link run (Network Link Conditioner or real LTE) sustains motion with no render gap beyond the watchdog bound and no permanent freeze. Third, under induced loss the host log shows the adaptive controller stepping the encoder bitrate down and recovering it as the link clears. Until the ceiling and the freeze-recovery land, status stays `proposed`.

## Pros and Cons of the Options

### Option A (static knobs)

- Good, because it ships with zero code and is a useful manual escape hatch on a known-bad link.
- Bad, because it cannot track a mid-session link change, hardcodes link policy per machine, and leaves the wedged-decoder freeze unfixed.

### Option B (bounded open loop)

- Good, because it stops the LTE freeze with a small, independently-correct change and needs no new wire message.
- Bad, because a fixed nominal bitrate still wastes headroom on a fast link and oversends between keyframes on a slow one.

### Option C (closed loop)

- Good, because it converges on the link's real, moving capacity and bounds recovery cost.
- Bad, because it adds a feedback channel, host rate state, and a tuning surface that needs device data to settle.

## Non-goals (captured, not in this decision)

- Selective packet repair (NACK). `MediaDatagramFrameRepairBuffer` already computes per-packet `resendRequests` and `Config.ownedMediaResendRingFrames` exists, but the client never sends them and the host never serves them. Recovery stays keyframe-only until the adaptive loop proves insufficient.
- Forward error correction (FEC) on the datagram stream.
- A crisp text-repair layer (that is ADR-0026 follow-up #4, a separate decision).

## Links

- ADR-0026 video-primary owned media (refined by this ADR; its follow-up #5 flagged the throttled-link gap this ADR resolves)
- ADR-0025 mixed-mode hardware video motion (the carrier this control layer sits over)
- ADR-0014 QUIC datagram owned media
- Apple `kVTCompressionPropertyKey_DataRateLimits` (VideoToolbox compression properties)
