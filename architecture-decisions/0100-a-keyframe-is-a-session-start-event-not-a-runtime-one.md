---
status: proposed
date: 2026-08-15
supersedes: ADR-0087
---

# A keyframe is a session-start event, not a runtime one

## Context and Problem Statement

On a 208kbps LTE link the picture froze for seconds at a time while the screen was barely
changing. Measured on one live session: **17 of 104 frames were keyframes, and they carried 74.7%
of all bytes.** A keyframe is ~44KB against a ~1.1KB delta, which at that rung is **1.7 to 2.2
seconds of wire time** during which nothing else moves -- long enough to look like a stall, which
triggers a stall-recovery keyframe, which is itself 2 seconds of silence. 124 stall recoveries
fired in 9.9 minutes.

None of this is the link refusing bytes. Sustained throughput while clean was 147kbps with
`lossPermille=0` and a 7ms floor round-trip. The freezes are frames we chose to send.

Affects `VideoToolboxOwnedMediaEncoder`, `OwnedMediaTransport`, and the resolution axis of
`MediaQualityController`.

## Decision Drivers

- A keyframe on a constrained link is a multi-second head-of-line block, so its cost scales
  inversely with the link we are trying to help.
- VideoToolbox already provides the cheap alternative: `kVTEncodeFrameOptionKey_ForceLTRRefresh`
  encodes a P-frame against an acknowledged long-term reference.
- The encoder falls back to an IDR **only** when it holds no acknowledged reference, so keeping one
  alive is the whole game.
- Whatever replaces the current safety net must still recover a client that has genuinely lost
  sync, without assuming the network cooperated.

## Considered Options

- **Option A**: Keep the current design and tune it -- stretch the periodic interval further, rate
  limit stall recovery harder.
- **Option B**: Treat an IDR as a session-start event only. Fix the encode geometry for the life of
  the connection, delete the periodic refresh, guarantee a live acknowledged reference, and make
  every runtime resync an LTR refresh.
- **Option C**: Keep resolution adaptation but re-acknowledge a reference immediately after each
  session recreate, shortening the reference-less window rather than removing it.

## Decision Outcome

Chose **Option B**. Option A is what ADR-0098 already did -- it stretched the periodic interval in
proportion to the budget -- and tonight's measurement shows the stretch is insufficient at
208kbps: **8 of 17 keyframes were still `rest`, the encoder's own periodic placement, on a screen
whose deltas were 1,093 bytes.** Option C keeps a window that measured **9-16 seconds** wide, during
which every refresh falls back to a 44KB IDR; shortening a self-inflicted hole is worse than not
digging it.

Two probes against the real encoder make Option B's keystone a measurement rather than an argument:

- **Acknowledged references are retained.** Acknowledge tokens once, report nothing for 10+ frames,
  then force 5 refreshes: all 5 returned LTR deltas, zero IDRs. Report-once-then-clear is a correct
  use of `kVTEncodeFrameOptionKey_AcknowledgedLTRTokens`.
- **Scaling into a fixed session preserves them across a quality change.** Same harness, one session
  at constant geometry with the input detail changed: 4 forced refreshes, **0 fallbacks**, deltas
  averaging 4,518B. Recreating the session at a new size instead cost **6x the keyframes** and took
  the keyframe share of bytes from **5% to 33%**.

The four changes, in dependency order:

1. **Fixed encode geometry for the life of the connection.** `VTCompressionSessionCreate` takes
   width and height as create-time parameters and exposes no property to change them, so a rescale
   *must* recreate the session and *must* discard every acknowledged reference. Resolution either
   leaves the ladder on constrained links or adapts through
   `kVTCompressionPropertyKey_PixelTransferProperties` into a constant encode size.
2. **Guarantee a live acknowledged reference.** Track it as explicit state rather than hoping: the
   stream is not "established" until one token is acknowledged. This is what makes 3 and 4 safe.
3. **Delete the periodic refresh.** Remove `MaxKeyFrameInterval` and `MaxKeyFrameIntervalDuration`.
4. **Recovery is always an LTR refresh.** `stallRecovery` and `clientRequest` become refreshes
   unconditionally; an IDR requires the client to *declare* it holds no references, which the wire
   already carries as `clientHasNoReferences`.

Ordering is load-bearing: doing 3 before 2 removes the safety net while the hole it covers is still
open.

### Consequences

- Good, because the dominant byte cost on a constrained link goes away. Live measurement of the
  first piece alone -- pinning resolution, which is item 1 by brute force -- took **>=1s freezes
  from 13.6% of seconds to 5.3%** and p90 gap from 1340ms to 707ms.
- Good, because it removes a class of bug rather than an instance: today five separate call sites
  can force a keyframe, and after this only session start and an explicit client declaration can.
- Bad, because resolution stops being a free adaptation axis. Until the PixelTransfer path exists,
  constrained links trade sharpness for smoothness with no way to buy it back.
- Bad, because the safety net goes. A client whose explicit resync never arrives previously
  recovered within the periodic interval; afterwards it depends on the request path working. That
  path is exercised constantly (`client-request` keyframes appear in logs), but the failure mode
  changes from "recovers late" to "does not recover".
- Neutral, because `resumeWatching` and the first frame stay true keyframes. Their references are
  genuinely stale or absent, which is exactly the condition an IDR is for.

### Confirmation

The `owned media video sent` line carries `refresh=` and the encoder logs `true-keyframe cause=`
and `ltr-refresh-result outcome=`, all added while diagnosing this. Together they make compliance
directly observable:

- `outcome=idr-fallback` should approach zero in steady state; it was 63% during the worst measured
  window and 5.4% in a healthy one.
- `refresh=rest` should disappear entirely once item 3 lands.
- `cause=resolution-change` should disappear once item 1 lands.
- Keyframe share of bytes is the headline number: **74.7% measured, target under 10%.**

A session that shows a `true-keyframe` with any cause other than `first-frame` or
`client-has-no-references` is a regression against this ADR.

## Pros and Cons of the Options

### Option A -- tune the current design

- Good, because it is the smallest change and ADR-0098's machinery already exists.
- Bad, because it was already tried. ADR-0098 measured the periodic refresh as the single largest
  keyframe source (25 of 53 in a 45-minute session, none requested by anything) and stretched the
  interval; at 208kbps it is still 8 of 17.
- Bad, because tuning cannot fix the resolution axis at all -- the session recreate is a platform
  constraint, not a threshold.

### Option B -- IDR only at session start

- Good, because both of its load-bearing assumptions are measured against the real encoder rather
  than reasoned from the header.
- Good, because it makes the expensive path require *evidence* (a client declaration) instead of a
  heuristic.
- Bad, because it is the largest change, touching the encoder's session lifecycle, the quality
  ladder's axes, and the recovery path together.

### Option C -- re-acknowledge after each recreate

- Good, because it leaves resolution adaptation intact.
- Bad, because the window cannot be closed, only narrowed: a new session has no reference until a
  frame has been emitted, sent, received, and acknowledged -- measured at 9-16 seconds on this link,
  not the one round trip intuition suggests.

## Links

- ADR-0087 -- periodic keyframe placement belongs to the encoder (superseded by item 3)
- ADR-0088 -- the queueing detector, whose stall signal drives `stallRecovery`
- ADR-0098 -- rate-match the media path to the link; its budget-scaled keyframe interval is the
  approach this replaces
- `VTCompressionProperties.h`, macOS 26.5 SDK -- `kVTCompressionPropertyKey_EnableLTR`:
  "Encoder will encode a new reference frame using an acknowledged LTR, or an IDR if no LTR frames
  have been acknowledged."
