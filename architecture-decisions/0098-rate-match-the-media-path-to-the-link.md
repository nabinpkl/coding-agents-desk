---
status: proposed
date: 2026-08-13
---

# Rate-match the media path to the link

## Context and Problem Statement

The phone freezes on cellular while the adaptive ladder reports itself healthy. Measured on
2026-08-13 from the host's own `owned-media` log, 838 quality windows, client on LTE
(`linkQuality=moderate expensive=true`), host on wifi.

The ladder is not failing to descend. Re-enabled at 18:32:45 it went 30 → 24 → 15 → 10 → 6 fps and
1.0 → 0.33 scale in ten seconds and sat on the emergency floor with nothing left to give. The
freezes continued, because frame rate is not the axis that fails:

```
18:33:14  sentKbps=768  targetKbps=300  keyframes=1   actualFps=6 targetFps=6 fpsDeficit=0
18:33:15  sentKbps=13                                  <- encoder repaying the overshoot
18:33:16  sentKbps=14   rttInflation=5.0
18:33:19  datagramsRecv=0  maxArrivalGapMs=936   -> stall no-ack-at-cap, flush 6, force keyframe
18:33:20  datagramsRecv=5  maxArrivalGapMs=2264  -> stall again
```

A 96,408-byte keyframe left in about 2ms against a link draining at 37KB/s. The user sees the
burst that cannot be delivered, then two seconds of near-empty frames while the encoder pays it
back. Four independent defects produce this, spanning
`host/AgentDeskHost/MediaQualityController.swift`,
`host/AgentDeskHost/VideoToolboxOwnedMediaEncoder.swift`, and the datagram send path (then
`OwnedMediaDatagramSendPacer.swift`, replaced here by `OwnedMediaSendScheduler.swift`):

**D1 — the ladder cannot descend during a freeze.** A freeze yields `completedFrames +
expiredFrames == 0` (nothing acked because nothing arrives; nothing expired because expiry needs a
client report the client is not sending), which routes to the `total == 0` branch whose only
outcomes are climb and hold. Every descent branch is written after that early return. Measured: 25
adaptive-era windows had zero completions with frames still in flight, and 6 carried
`stalePressure=true` and still logged `reason=idle`. That branch also resets the stale streak,
which is why 12 stale windows produced exactly one `stale-capacity-down`.

**D2 — nothing rate-matches the wire to the receiver.** At a 1050-byte payload a 96KB keyframe is
92 datagrams; the burst pacer sent 32 back-to-back with a 1ms pause. Its stated purpose is that a
large frame "does not flood the QUIC datagram send buffer" — a host-side resource. No component
paced to the link's drain rate.

**D3 — keyframes are unbudgeted.** 25 of 53 keyframes were `requestedReason=none`: the GOP timer
firing every 15.1s at 91–108KB, 51kbps of a 300kbps budget delivered as a lump. `DataRateLimits`
does not cap them — 43,441 vs a 33,750 cap, 96,408 vs 56,250, 132,831 vs 99,188 — because it is a
sliding-window average honoured by starving the frames after the IDR.

**D4 — the link is measured well and steered by proxies.** `roundTrip.inflationRatio` (ADR-0088)
reaches one log line. `clientLinkStalled` (ADR-0088) only vetoes a climb. `maxArrivalGapMs` only
feeds `clientLinkStalled`. `presentationSkipBytes` feeds nothing, despite its own wire comment
naming it "the number that would justify the host declining to send at all". Every decision is
made from host-side proxies. During the freeze `inflationRatio` read 5.0 and the ladder held.

## Decision Drivers

- The instantaneous wire rate must be bounded by something. Today nothing bounds it, and both
  candidates for the job (`DataRateLimits`, the burst pacer) bound something else.
- A window that describes a freeze must be able to lower the rung. Today it is the one window shape
  that cannot.
- ADR-0088 built detectors on the premise that host-side proxies were insufficient. Leaving them
  diagnostic-only keeps the premise and discards the remedy.
- No wire change, no protocol version, no client release: the stable client is a TestFlight daily
  driver and this is a host-side control problem.

## Considered Options

- **Option A**: tune the existing dials — scale the burst pause off `targetKbps`, shorten the GOP
  at low rungs.
- **Option B**: replace the rung ladder with a rate-based controller driven by a capacity estimate.
- **Option C**: add the missing authority — a send-rate governor at the wire — and make the
  measurements that already exist load-bearing, keeping the ladder.

## Decision Outcome

Chose **Option C**.

Option A helps and leaves the architecture where it is: the encoder's *requested average* still
standing in for the link's *delivered rate*, and the ladder still structurally unable to descend
from the windows that describe a freeze. The next link that behaves differently reopens the same
investigation. Option B discards a discretization that is not the defect — the rungs were reached
correctly and quickly; their inputs were wrong — and rewrites the control law on the strength of an
estimator that has not yet been measured on this path.

The measurement that decides it: **the governor already existed**. `GraphicsSendPacer` is a
correct, unit-tested token bucket whose own comment names this exact failure — "100KB+ frames that,
ungated, sum to ~4x the link and saturate the send buffer... the freeze cascade". It was written for
the reliable graphics channel ADR-0026 retired, and has kept its tests and lost its caller ever
since. The datagram video path that replaced that channel never got one. So the work is not to
invent congestion control; it is to put the governor on the path that now carries the bytes, and to
connect four detectors that are already computing the right numbers.

The change lands in four parts:

1. **The wire gets a budget.** `LinkSendPacer` (the moved and renamed bucket) governs
   `OwnedMediaSendScheduler`, through which every live frame and every repair packet passes. Pacing
   is per packet, replacing the fixed 32-packet/1ms grouping, because that grouping bounded packet
   count and never bytes. The rate is set wherever the encoder's bitrate is set, so the two cannot
   drift.
2. **Delivery is separated from production** in the controller's input, and the first question
   `observe` asks becomes delivery rather than frame count. A stalled link descends whatever the
   production count.
3. **One owner for keyframes**, preferring a long-term-reference refresh over an IDR wherever a
   valid acked reference exists, with the GOP ceiling scaled to the rung, and no native-resolution
   keyframe emitted on the descent or reconnect paths.
4. **The estimator** turns acked bytes, RTT inflation and the client's arrival gaps into a
   delivered-rate figure that feeds both the governor's refill rate and the descent trigger.

### Consequences

- Good, because the burst that overflows the link becomes unconstructable rather than merely
  discouraged: a 96KB keyframe at 300kbps occupies the wire for the ~2.6s it was always going to
  need, instead of 2ms followed by two seconds of invisible queueing.
- Good, because the encode drain awaits the send, so pacing is also backpressure: captures are
  replaced rather than queued while the wire is busy, which is what ADR-0073's freshness-first
  design wanted and could not previously observe.
- Good, because repair traffic and live video finally share one accounting. Repair is requested
  exactly when the link is already failing, which was the worst possible time for it to be
  unmetered.
- Bad, because the first keyframe after a downshift is visibly slower at the emergency rung. The
  bytes always took that long; they were queueing where nothing could see them, with a stall
  recovery firing on top. Part 3 exists to make that cost rare rather than to hide it.
- Bad, because pacing makes a keyframe's send duration visible to the cadence signals that were
  previously blind to it. `productionDiagnostics.noteSent` runs after the send completes, so a
  2.6s paced keyframe now shows as a `maxGapMs` above `ownedMediaFreezeGapMs`, and on an already
  stressed link that reads as freeze pressure and downshifts — which forces a resolution-change
  keyframe, which is also slow. Part 3 is the mitigation and is not optional: this arc must not
  reach a device with part 1 landed and part 3 not. Traced, not measured; the device run is what
  settles whether the loop actually closes.
- Bad, because `ownedMediaDataRateLimitRatio` now has two consumers with one meaning. Pacing the
  wire tighter than the encoder's own allowance would move the queue onto the host rather than
  remove it, so the two are derived from one number deliberately; a future change to it moves both.
- Neutral, because the rung ladder, its thresholds and its recovery machinery are untouched. This
  changes what the ladder is told and what happens to the bytes it asks for, not how it chooses.

### Confirmation

Standing signals, all readable from the existing log format with no new instrumentation:

- `LinkSendPacerTests` pins the budget arithmetic, and `OwnedMediaSendSchedulerTests` pins that the
  scheduler consults it. A regression that removes the pacing makes the timing test finish in
  microseconds.
- Periodic keyframe bytes against the `dataRateCapBytes` the same log line reports. Today 1.29× to
  1.71×; a return above 1.0 means the keyframe budget stopped binding.
- Peak `sentKbps` against `targetKbps` in a keyframe window. Today 768 against 300.
- Count of `no-ack-at-cap` stall recoveries, and of windows with `completedFrames=0` and non-zero
  in-flight. Today 12 and 25 in roughly two minutes; both should reach zero, the second because
  such a window is no longer classifiable as idle.

## Pros and Cons of the Options

### Option A — tune the existing dials

- Good, because it is a small diff against known-safe code.
- Bad, because it leaves every one of the four defects in place and fixes only their current
  symptom.
- Bad, because it keeps two mechanisms (burst grouping and the encoder's average) each half-doing
  a job neither owns.

### Option B — replace the ladder with a rate-based controller

- Good, because a measured capacity is a better input than a streak counter.
- Bad, because the ladder reached the right rung in ten seconds; replacing it spends the arc's risk
  on the part that worked.
- Bad, because it would land the estimator as a load-bearing control input before there is a device
  measurement of how well it tracks this path.

## Links

- ADR-0026 video-primary owned media (retired the channel `GraphicsSendPacer` was written for)
- ADR-0027 congestion-adaptive video (`DataRateLimits`, whose ceiling this records as an average)
- ADR-0033 adaptive media quality ladder (the rungs, unchanged)
- ADR-0073 freshness-first owned media (the backpressure this makes observable)
- ADR-0087 stall recovery is transport, not quality policy
- ADR-0088 measure link health ourselves (the detectors this makes load-bearing)
- ADR-0090 recover with a long-term reference instead of a keyframe
- SPEC §Owned media
