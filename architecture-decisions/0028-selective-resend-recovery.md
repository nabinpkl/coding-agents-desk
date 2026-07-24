---
status: superseded by ADR-0073
date: 2026-06-26
refines: ADR-0027
superseded-by: ADR-0073
---

# Selective packet resend (NACK) and bounded keyframe recovery for lossy links

## Context and Problem Statement

ADR-0027 bounded the encoder burst and closed the bitrate loop, and that removed the permanent LTE freeze. A device run over throttled LTE then showed residual symptoms: motion is steppy and lags the host scroll, while WiFi stays smooth. Host `owned-media` logs name the cause. During a hard scroll the keyframes are large (frame 480 = 279 KB / 267 packets, frame 603 = 301 KB / 288 packets, the requested recovery keyframes 395 and 401 = 240 KB / ~230 packets), and the only loss-recovery path is a keyframe request. So a single dropped packet forces a full keyframe, and that keyframe is itself too large to cross a lossy link intact: a 288-packet frame at 0.5% per-packet loss fails to assemble about 76% of the time, at 1% about 94% (`0.99^288 ≈ 0.055`). The client then requests another keyframe, which is also ~288 packets, and the logs show exactly this storm: keyframe-requests for frame 387 and 391 inside one second, two 240 KB keyframes sent back to back. The repair buffer delivers frames strictly in order, so each failed recovery is a stall (the lag) followed by a burst when one finally lands (the stepping). On WiFi there is no loss, the keyframe arrives first try, and none of this fires.

The mechanism to repair single-packet loss cheaply already exists but is inert. `MediaDatagramFrameRepairBuffer` computes per-frame `resendRequests` (the missing indexes of an overtaken-but-incomplete frame, bounded by `maxResendPackets`) and arms a repair deadline. The wire already carries it: `OwnedMediaControlKind.packetResendRequest` and `OwnedMediaControlMessage.packetIndexes` are defined in both `SharedTypes.swift`. The host already has `OwnedMediaResendRing` (a bounded by-frameId ring of recently-sent packets) and `Config.ownedMediaResendRingFrames` / `ownedMediaMaxResendPackets`. None of it is wired: the client never sends the computed `resendRequests`, and the host never remembers a sent frame's packets nor serves a resend. Scope: `OwnedMediaTransport` (host send site + datagram control handler; client datagram rx handler), `OwnedMediaResendRing`, `Config` (a client keyframe-request gap knob).

## Decision Drivers

- Fix LTE recovery without regressing the validated WiFi path. The good link must stay untouched.
- Repair an isolated packet loss without sending a full keyframe, so recovery load cannot exceed link capacity.
- Keep keyframe recovery as the fallback for a frame that resend cannot save in time; never wedge.
- Reuse the existing scaffolding. The hard part (computing the missing indexes) is already built and tested.
- Smallest correct step first; defer the structural and always-on-cost options.

## Considered Options

- **Option A**: Tune keyframe-only recovery. Rate-limit and suppress in-flight keyframe requests so a loss burst does not fan out into a keyframe storm. Cheap, client-only.
- **Option B**: Activate selective resend (NACK). Client sends the repair buffer's `resendRequests` over the existing `.packetResendRequest` control message; the host remembers each sent frame's packets in `OwnedMediaResendRing` and re-emits the named indexes. Repairs a single-packet loss with a handful of packets instead of a ~288-packet keyframe. Keyframe recovery stays as the past-deadline fallback.
- **Option C**: Attack keyframe size. Motion-aware capture downscale (`Config.ownedMediaCaptureScaleDown` driven by the motion signal) and/or HEVC intra-refresh / gradual decoder refresh so no single frame is a 288-packet atomic unit.
- **Option D**: Forward error correction. Parity packets so an isolated loss is recovered with no round trip.

## Decision Outcome

Chose **Option B as the fix, with Option A's in-flight keyframe suppression as a cheap complement**. B is the targeted answer to what the logs show: it removes the giant recovery keyframe from the common single-loss case, which is the storm's root. Its regression risk on the validated path is low because it is purely additive and loss-triggered: on a clean link the repair buffer emits no `resendRequests`, so the client sends nothing and the host serves nothing, leaving WiFi behavior bit-for-bit unchanged. Its failure mode is "the resend arrived too late, behind newer frames" (then the keyframe fallback still fires), not "it broke the working case". The scaffolding being mostly built makes B the smallest correct step rather than a large new mechanism. A is folded in because bounding the keyframe-request rate is a few lines and stops the storm even before a resend lands, but A alone is rejected as the answer: a rate-limited keyframe is still a keyframe that cannot traverse the lossy link, so it does not fix the cause. C and D are captured, not started. C is heavier, changes the encode path for both links, and a resolution change is itself a visible keyframe and sharpness step; it is the next lever if keyframes stay too large after B. D taxes the common no-loss case with parity on every frame, the one option that degrades the good link to help the bad one, so it is last.

### Consequences

- Good, because an isolated packet loss is repaired with a few packets instead of a ~288-packet keyframe, so recovery stops being the thing that saturates the link.
- Good, because the validated WiFi path is untouched: no loss means no resend traffic on either end.
- Good, because keyframe recovery remains as the bounded fallback for a frame resend cannot save, so the stream still re-syncs in the worst case.
- Bad, because the host now keeps a bounded ring of recent packets (memory) and serves resends (a new control path), and a resend can still arrive too late behind newer frames. The first device validation proved the original 8-frame ring was too small for LTE request latency, so the default is 240 frames.
- Neutral, because the wire type already carries the fields and chroma stays 4:2:0; this activates dormant scaffolding rather than adding a protocol surface.

### Confirmation

Unit tests assert `OwnedMediaResendRing` serves the requested indexes of a remembered frame, reports misses for unknown frames or indexes, honors the per-request cap, and evicts past capacity; that a `.packetResendRequest` carrying `packetIndexes` round-trips through the control codec on both ends; and that the client evicts locally dropped frames before emitting resend requests, so it does not NACK frames it has already abandoned.

The first throttled-LTE validation attempt on 2026-06-26 did not pass: host logs showed `resend-miss` lines and continued keyframe fallback, with no `resend-served` evidence. The follow-up fix keeps 240 host frames in the resend ring and drops hopeless client frames before NACK. ADR-0028 remains proposed until a new throttled-LTE run shows resends served, loss-driven keyframe-requests per session below the adaptive-only baseline (8 per session from R91), and the steppy/lag easing without a WiFi regression.

## Non-goals (captured, not in this decision)

- HEVC intra-refresh / gradual decoder refresh and motion-aware capture downscale (Option C). The keyframe-size attack; opens if keyframes stay too large to traverse the link after resend lands.
- Datagram FEC (Option D). Opens only if loss is steady and low-rate enough that round-trip resend is too slow.

## Links

- ADR-0027 congestion-adaptive video (refined by this ADR; its captured NACK non-goal is promoted here on the evidence that keyframe-only recovery is insufficient on LTE)
- ADR-0025 mixed-mode hardware video motion (the carrier this recovery sits over)
- ADR-0014 QUIC datagram owned media
