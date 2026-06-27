---
status: proposed
date: 2026-06-26
refines: ADR-0028
---

# Capacity survival rung: trade frame rate and bitrate for a slow link

## Context and Problem Statement

ADR-0027 closed the bitrate loop and ADR-0028 added selective resend; together they handle a *lossy* link. A device run on a genuinely *slow* link still freezes, which is a different failure. Adaptive bitrate, NACK, and keyframe recovery all address loss (packets dropped on a link that could otherwise carry the stream). They do nothing for capacity: when the link's sustained throughput is below what native-Retina video needs even at the 800 kbps bitrate floor, the bytes simply do not fit the pipe, the controller bottoms out at the floor, keeps oversending, the queue overflows, and it freezes. The host log on such a run shows the controller pinned at floor with continued loss and no lower gear to shift into.

The controller has one normal bitrate lever and a hard 800 kbps floor. The byte rate of the stream is roughly `pixels x fps x bits-per-pixel`. Normal bitrate adaptation touches the last factor and bottoms out. The unused factors are pixels (resolution) and fps (cadence), but cadence alone is not enough if VideoToolbox spends the same 800 kbps across fewer, larger frames. This ADR adds a survival rung below the normal floor: once 800 kbps is pinned and loss persists, the controller lowers fps and the effective wire bitrate together toward a separate survival floor. The produce-cadence gate already exists in the encode pump (`MotionGovernor.policy.minFrameIntervalNs`, today driven only by the unacked-cap backpressure count), so adding the cadence input needs no session recreate and no client change. Lowering the effective bitrate reuses the existing live `updateBitrate` path. Resolution (the ADR-0028 Option C capture half) requires a VTCompressionSession recreate and an untested client resolution-resync, so it is deferred to its own decision. Scope: `VideoBitrateController` (gains fps plus survival bitrate policy), `VideoToolboxOwnedMediaEncoder` (live `updateExpectedFrameRate` and existing live `updateBitrate`), `OwnedMediaTransport` (applies both targets and the produce-cadence gate reads the target fps), `Config`.

## Decision Drivers

- Convert the slow-link failure from "freeze" into "soft and choppy but alive". Degrade cadence and wire-rate; never wedge.
- Touch nothing on a link with headroom. The validated WiFi/LTE-with-capacity path must stay bit-for-bit unchanged.
- Cheapest capacity lever first. fps reduction and sub-floor bitrate reuse live knobs that already exist; resolution is a session recreate, deferred.
- One control surface. The fps axis lives in the existing adaptive controller, fed by the same link-health window, not a second loop.

## Considered Options

- **Option A**: Lower the bitrate floor only. One-line change. Lets the controller go softer, but below a floor the image is unwatchable mush and the bytes still may not fit; it adds no new axis.
- **Option B**: Capacity survival rung. The adaptive controller gains an fps axis plus a survival bitrate floor. It steps produce/encode frame rate and effective bitrate down only once the normal bitrate floor is pinned and the link is still losing, recovering bitrate before cadence. The produce-cadence gate widens to match.
- **Option C**: Capacity-driven resolution downscale (ADR-0028 Option C capture half). Higher leverage (pixels dominate the byte rate) but needs a mid-stream VTCompressionSession recreate and a client resolution-resync that is currently untested.

## Decision Outcome

Chose **Option B**. It is the cheapest lever that adds a genuinely new degree of freedom while also lowering the byte target below the normal floor when the evidence says 800 kbps does not fit. Cadence is the second factor in the byte-rate product, the gate that spends it already exists in the pump, and the encoder already supports live bitrate retargeting, so the change is controller policy plus one `max()` in the produce gate, no session recreate, no client or wire change. It is dormant by construction: the survival rung only starts once normal bitrate is at the floor and still losing, and the produce gate applies a capacity interval only when the target fps is below the ceiling, so a link with headroom runs exactly as before. Option A is rejected as the answer because lowering the floor alone adds no cadence axis and trades sharpness for mush before the normal bitrate loop is exhausted. Option C is the higher-leverage follow-up but carries the one real cost in the tree (mid-stream session recreate plus untested client resolution handling), so it is sequenced after B proves the capacity-degradation shape. B is also the first rung of the broader degradation ladder (bitrate floor -> survival bitrate plus cadence -> resolution -> holding mode) that a later decision can complete.

### Consequences

- Good, because a genuinely slow link degrades to low-fps lower-bitrate motion instead of freezing; the eye tolerates low cadence and softness during scroll far better than a frozen frame.
- Good, because the lever is dormant on any link with bitrate headroom, so the validated path is untouched.
- Good, because the encoder's expected frame rate tracks the produce cadence and its bitrate target drops with survival cadence, so fewer frames do not simply get the same 800 kbps budget.
- Bad, because there are now two cadence inputs (the governor's backpressure interval and the controller's capacity interval) reconciled by a `max()`, one more interaction to reason about.
- Neutral, because recovery order is a policy choice (survival bitrate restored to normal floor, then bitrate restored to ceiling, then cadence), encoded as knobs and revisitable with device data.

### Confirmation

Pure-logic controller tests assert fps holds at the ceiling while bitrate still has room to fall, survival mode starts only once bitrate is pinned at the normal floor under loss, survival mode lowers both fps and bitrate toward their survival floors, recovery raises bitrate before cadence, and neither axis exceeds its ceiling. A genuinely-slow-link device run is the acceptance: the host log shows `bitrate-step` and `fps-step` rungs down keeping the stream alive (no freeze) and stepping back up as the link clears, with no change on a link that has headroom.

## Non-goals (captured, not in this decision)

- Capacity-driven resolution downscale (ADR-0028 Option C capture half); the higher-leverage but session-recreate-bearing lever, deferred to its own decision.
- A full degradation ladder that orchestrates bitrate, cadence, resolution, and a last-resort holding mode; this ADR is its first survival rung.
- Delay-based (bufferbloat) congestion sensing as an earlier signal than frame loss.

## Links

- ADR-0028 selective resend (refined by this ADR; this is the survival-rung half of its captured capacity ladder)
- ADR-0027 congestion-adaptive video (the bitrate loop this survival rung extends)
- ADR-0025 mixed-mode hardware video motion (the carrier and the `MotionGovernor` cadence gate this reuses)
