---
status: accepted
date: 2026-07-23
supersedes: ADR-0028
---

# Freshness-first owned media drops obsolete frames instead of waiting for ACKs

## Context and Problem Statement

A fixed 1400 kbps / 10 fps / 0.5-scale mobile-data run produced client presentation
gaps up to 7.834 seconds. Six selective-resend requests all expired, host ACK p95
reached 4.021 seconds, and the host reset stale in-flight state 21 times while the
client decoder and renderer reported no stalls or drops. The media path turned
temporary packet loss and jitter into accumulated latency by holding completed
frames behind an incomplete frame and stopping production behind old ACKs.

## Decision Drivers

- Live desktop video values the newest decodable state over complete frame history.
- Input and control must remain usable while video delivery degrades.
- Video memory and queue depth must stay bounded without waiting for an obsolete ACK.
- Recovery must keep the last good image visible and converge on one fresh keyframe.

## Considered Options

- **Option A**: Increase or adapt the selective-resend deadline.
- **Option B**: Keep ACK backpressure but shorten the stale reset timeout.
- **Option C**: Make owned media latest-frame-wins and keep resend opportunistic only.

## Decision Outcome

Chose **Option C**. The host may send one frame and retain one replaceable latest
capture, but an in-flight cap abandons old accounting entries instead of blocking
admission. The client may use a resend only before a newer complete frame overtakes
the gap; after that it drops obsolete assemblies, keeps the last displayed image,
and waits for one coalesced keyframe. Capacity pacing may delay the next send slot,
but captures overwrite the pending mailbox during that delay.

The first validation profile is explicitly fixed, with adaptive quality disabled:
180 kbps, 1 fps, and 0.5 resolution scale. The transport invariant applies
independently of quality policy; the adaptive ladder remains available but is not
retuned by this decision.

### Consequences

- Good, because packet loss can reduce cadence without making displayed state
  progressively older.
- Good, because old ACKs and late repairs cannot hold the media pump or release the
  wrong newer accounting entry.
- Bad, because a missing HEVC reference frame discards subsequent deltas until a
  fresh keyframe arrives.
- Neutral, because ACK continues to mean complete transport receipt; client
  presentation skips are reported separately.

### Confirmation

Pure tests prove that frame and byte caps abandon the oldest entries and admit the
newest capture without a backpressure retry; stale ACKs cannot release newer
entries; one active send plus one replaceable capture is the maximum pending video
state; a newer complete frame skips an older incomplete frame without a timer; and
deltas are discarded behind one coalesced keyframe request until a keyframe
resynchronizes the decoder.

An authorized physical run must hold the fixed 180 kbps / 1 fps / 0.5 target, report
no media admission retry for backpressure, keep pending capture depth at one, avoid
stale-in-flight resets, and recover to the newest keyframe rather than replaying
queued history.

## Pros and Cons of the Options

### Option A

- Good, because isolated packet loss can avoid a keyframe.
- Bad, because any deadline that blocks a newer frame converts jitter into visible
  latency and eventually fails on a slower path.

### Option B

- Good, because it is a small host-only change.
- Bad, because it still waits behind obsolete delivery state and merely changes how
  long the freeze lasts.

### Option C

- Good, because queue depth and freshness have explicit bounds.
- Bad, because recovery quality depends on a keyframe fitting the constrained path.

## Links

- ADR-0025 mixed-mode hardware video motion
- ADR-0028 selective packet resend and bounded keyframe recovery
- ADR-0030 single QUIC session transport
- ADR-0033 adaptive media quality ladder
