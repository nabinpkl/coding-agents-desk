---
status: proposed
date: 2026-06-26
refines: ADR-0028
---

# Capacity-driven cadence: trade frame rate for survival on a slow link

## Context and Problem Statement

ADR-0027 closed the bitrate loop and ADR-0028 added selective resend; together they handle a *lossy* link. A device run on a genuinely *slow* link still freezes, which is a different failure. Adaptive bitrate, NACK, and keyframe recovery all address loss (packets dropped on a link that could otherwise carry the stream). They do nothing for capacity: when the link's sustained throughput is below what native-Retina video needs even at the 800 kbps bitrate floor, the bytes simply do not fit the pipe, the controller bottoms out at the floor, keeps oversending, the queue overflows, and it freezes. The host log on such a run shows the controller pinned at floor with continued loss and no lower gear to shift into.

The controller has exactly one lever, bitrate, and a hard floor. The byte rate of the stream is roughly `pixels x fps x bits-per-pixel`. Bitrate adaptation only touches the last factor and bottoms out. The unused factors are pixels (resolution) and fps (cadence). This ADR takes the fps factor, the cheaper of the two: the produce-cadence gate already exists in the encode pump (`MotionGovernor.policy.minFrameIntervalNs`, today driven only by the unacked-cap backpressure count), so adding a second cadence input needs no session recreate and no client change. Resolution (the ADR-0028 Option C capture half) requires a VTCompressionSession recreate and an untested client resolution-resync, so it is deferred to its own decision. Scope: `VideoBitrateController` (gains an fps axis), `VideoToolboxOwnedMediaEncoder` (live `updateExpectedFrameRate`), `OwnedMediaTransport` (the produce-cadence gate reads the target fps), `Config`.

## Decision Drivers

- Convert the slow-link failure from "freeze" into "soft and choppy but alive". Degrade cadence; never wedge.
- Touch nothing on a link with headroom. The validated WiFi/LTE-with-capacity path must stay bit-for-bit unchanged.
- Cheapest capacity lever first. fps reduction is a cadence gate that already exists; resolution is a session recreate, deferred.
- One control surface. The fps axis lives in the existing adaptive controller, fed by the same link-health window, not a second loop.

## Considered Options

- **Option A**: Lower the bitrate floor only. One-line change. Lets the controller go softer, but below a floor the image is unwatchable mush and the bytes still may not fit; it adds no new axis.
- **Option B**: Capacity-driven cadence. The adaptive controller gains an fps axis that steps the produce/encode frame rate down only once bitrate is pinned at the floor and the link is still losing, recovering after bitrate is restored. The produce-cadence gate widens to match.
- **Option C**: Capacity-driven resolution downscale (ADR-0028 Option C capture half). Higher leverage (pixels dominate the byte rate) but needs a mid-stream VTCompressionSession recreate and a client resolution-resync that is currently untested.

## Decision Outcome

Chose **Option B**. It is the cheapest lever that adds a genuinely new degree of freedom: cadence is the second factor in the byte-rate product, and the gate that spends it already exists in the pump, so the change is a controller axis plus one `max()` in the produce gate, no session recreate, no client or wire change. It is dormant by construction: fps only leaves the ceiling once bitrate is at the floor and still losing, and the produce gate applies a capacity interval only when the target fps is below the ceiling, so a link with headroom runs exactly as before. Option A is rejected as the answer because lowering the floor adds no axis and trades sharpness for mush without fixing the byte fit. Option C is the higher-leverage follow-up but carries the one real cost in the tree (mid-stream session recreate plus untested client resolution handling), so it is sequenced after B proves the capacity-degradation shape. B is also the first rung of the broader degradation ladder (bitrate floor -> cadence -> resolution -> holding mode) that a later decision can complete.

### Consequences

- Good, because a genuinely slow link degrades to low-fps motion instead of freezing; the eye tolerates low cadence during scroll far better than a frozen frame.
- Good, because the lever is dormant on any link with bitrate headroom, so the validated path is untouched.
- Good, because the encoder's expected frame rate tracks the produce cadence, so its bit allocation matches the lower rate rather than starving each frame.
- Bad, because there are now two cadence inputs (the governor's backpressure interval and the controller's capacity interval) reconciled by a `max()`, one more interaction to reason about.
- Neutral, because recovery order is a policy choice (bitrate restored to ceiling before cadence), encoded as a knob and revisitable with device data.

### Confirmation

Pure-logic controller tests assert fps holds at the ceiling while bitrate still has room to fall, steps down only once bitrate is pinned at the floor under loss, never drops below the fps floor, recovers only after bitrate is restored to the ceiling, and never rises above the fps ceiling. A genuinely-slow-link device run is the acceptance: the host log shows `fps-step` rungs down keeping the stream alive (no freeze) and stepping back up as the link clears, with no change on a link that has headroom.

## Non-goals (captured, not in this decision)

- Capacity-driven resolution downscale (ADR-0028 Option C capture half); the higher-leverage but session-recreate-bearing lever, deferred to its own decision.
- A full degradation ladder that orchestrates bitrate, cadence, resolution, and a last-resort holding mode; this ADR is its first rung.
- Delay-based (bufferbloat) congestion sensing as an earlier signal than frame loss.

## Links

- ADR-0028 selective resend (refined by this ADR; this is the fps half of its captured Option C)
- ADR-0027 congestion-adaptive video (the bitrate loop this cadence axis extends)
- ADR-0025 mixed-mode hardware video motion (the carrier and the `MotionGovernor` cadence gate this reuses)
