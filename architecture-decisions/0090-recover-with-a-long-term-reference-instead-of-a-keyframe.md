---
status: accepted
date: 2026-07-31
---

# Recover with a long-term reference instead of a keyframe

## Context and Problem Statement

Recovering a session after a network switch costs a full keyframe. Measured in one session on a
static desktop:

| frame | bytes |
|---|---|
| delta | 264 |
| keyframe | 250,416 |

That is roughly 950x. At the cellular throughput measured on the same device (460-529 kbps, so
about 60 KB/s), a 250 KB keyframe is **about four seconds of transmission**; the delta is about
four milliseconds. So after a handover we spend seconds pushing a full frame to redraw a screen
that, during a ten-second outage on a desktop, has usually barely changed.

The rest of the recovery cost is the radio: of an 11-second black screen measured on a
WiFi-to-cellular switch, about 9.5 seconds was the phone's cellular path not yet being usable.
The keyframe is the part of the tail we can actually remove.

## Decision Drivers

- The recovery frame should cost what the screen actually changed, not what a full frame costs.
- A recovery frame must never reference a frame the client does not have. Getting this wrong
  produces corrupted video rather than a clean failure, which is worse than the keyframe.
- No bespoke codec work. If the hardware encoder implements this, use it.

## Considered Options

- **Option A**: keep sending a keyframe on recovery (today).
- **Option B**: keep the host encoder alive across the drop and continue the stream normally.
- **Option C**: VideoToolbox Long Term Reference (LTR) frames with client acknowledgement.

## Decision Outcome

Chose **Option C**.

Option B is the naive form of the same idea and is actively dangerous. The host's encoder
advances its reference state on every frame it encodes, including the ones it sent into the
black hole and the client never received. Continuing normally would encode a delta against
frames the client cannot have, producing corruption. Option B is only safe if the encoder is
told which frames the client actually holds, which is Option C.

### The unknowns, resolved on this hardware

All four were settled by probing the encoder directly rather than from documentation, because
the question is what this Mac's hardware encoder supports, not what the API describes.

**LTR is available for HEVC, but only through the low-latency encoder path.** A default HEVC
session lists 158 properties and no LTR at all; `EnableLTR` is rejected with `-12900`
(`kVTPropertyNotSupportedErr`). Creating the session with
`kVTVideoEncoderSpecification_EnableLowLatencyRateControl` gives 109 properties including
`EnableLTR`, which then sets with status 0. (Default H264 exposes an older
`UseLongTermReference`, but we encode HEVC, so the low-latency path is the relevant one.)

**The encoder is already on that path**, so nothing had to move. It creates its session with
`EnableLowLatencyRateControl` today, which is why the property count it sees is 109 rather than
158 -- and why all seven properties it sets (`AllowFrameReordering`, `AverageBitRate`,
`DataRateLimits`, `ExpectedFrameRate`, `MaxKeyFrameInterval`, `MaxKeyFrameIntervalDuration`,
`RealTime`) already work there. LTR was one property away the whole time.

**The client needs no LTR support.** LTR retention is signalled in the bitstream through HEVC
reference picture sets, so a conformant decoder keeps the frame in its decoded picture buffer
because the stream says to, not on a timer. Decoding happens inside `AVSampleBufferDisplayLayer`
and no client-side LTR API exists or is needed. What the client must do is keep its sink alive
across a transport swap, which is a separate change already scoped.

**The corruption failure mode is handled by the encoder, not by us.** From
`VTCompressionProperties.h`: the encoder "will encode a new reference frame using an
acknowledged LTR, or an IDR if no LTR frames have been acknowledged." So the encoder tracks
which references the client confirmed and degrades to a keyframe by itself when none is usable.
The dangerous case cannot be reached by forgetting to handle it.

### What the change actually is

The encoder already creates its session with `EnableLowLatencyRateControl`, so no path change
was needed -- LTR was one property away the whole time. Probing the encoder's exact
specification (hardware-accelerated **and** low-latency together, which the first probe omitted)
confirms `EnableLTR` is listed and sets with status 0.

1. Set `EnableLTR` on the existing session.
2. Read `kVTSampleAttachmentKey_RequireLTRAcknowledgementToken` from output sample buffers and
   carry the token on the wire with the frame.
3. The client acknowledges tokens for frames it decoded, extending the existing `frameAck`.
4. The host passes confirmed tokens back as `kVTEncodeFrameOptionKey_AcknowledgedLTRTokens`.
5. On recovery, encode with `kVTEncodeFrameOptionKey_ForceLTRRefresh` instead of forcing a
   keyframe.
6. The host encoder must survive the drop. It was `private let encoder` on
   `OwnedMediaTransport`, so a new session built a new encoder with no reference state -- which
   is why a fresh session always emitted an IDR regardless of what the client still held. It is
   now injected and owned by the app delegate, **keyed by session id**, and released when the
   session ends.

   Keyed by session rather than by device, and that took a correction. Keying by device was
   wrong in a way that only shows up on a path nobody exercises during development: the app
   restarting. A resume keeps its session id and takes the surface-preserving teardown, so the
   client still holds the decoder the encoder's references live in -- that is the case this ADR
   is for. A fresh dial does not. Its client builds an empty decoder, and the resume material
   is in-memory only, so a restarted app always dials fresh. A device-keyed encoder would hand
   that new decoder its predecessor's reference state.

   The failure is worse than a corrupt frame. The encoder's frame counter persists too, so
   `frameId == 1` never fires and nothing forces a true keyframe. The new client cannot decode
   the first delta, asks for a keyframe, and that request routes straight back through
   `requestLtrRefresh` into another delta against the same unreachable reference. It is a
   livelock, not a glitch, and it would have looked like "the app just shows black after a
   restart". Keying by session id makes the encoder's lifetime exactly the client decoder's
   lifetime, which is the invariant the whole mechanism rests on.

Two things about (5) that only became clear while building it.

**The refresh replaces the forced keyframe rather than accompanying it.** Every path that wants
a refresh -- client keyframe request, stall recovery -- also sets a keyframe reason, because
that is how a resync has always been expressed. A first attempt guarded the refresh with
`!forceKeyframe`, which meant it could never fire: the feature would have been fully wired and
completely inert. Two reasons keep a true keyframe: `initial`, which has nothing to reference,
and `resolutionChange`, which invalidates every existing reference so a delta against one would
be garbage even if the client still held it.

**Most of the resync cost is not the client asking for it.** Counted over one session:
`resolution-change` 129, encoder-placed 96, `capture-requested` 33, `stall-recovery` 30,
`client-request` 5. Routing only explicit client requests would have addressed five keyframes
out of nearly three hundred. Stall recovery is the one that matters, and it is the same kind of
event -- the client lost frames and needs to resync -- so it takes the same path.

### Consequences

- Good, because recovery after a switch costs what changed rather than a fixed 250 KB, removing
  roughly four seconds from the tail of a cellular reconnect.
- Good, because the acknowledgement bookkeeping is the encoder's, and its fallback is a
  keyframe, so the worst case is exactly today's behaviour.
- Good, because rate control does not change at all. An earlier draft assumed a move to the
  low-latency encoder and warned that the quality ladder, tuned against the current one, would
  need re-measuring. The encoder was already there, so the ladder is untouched and no
  re-measurement is owed.
- Bad, because it only pays off when the resolution is unchanged across the recovery. The ladder
  rescales aggressively (3600x2338 -> 2700x1752 -> 1800x1168 within three seconds in one
  session), and a resolution change invalidates the references. The rung should be pinned across
  a resume window, but not permanently -- adaptation is what makes cellular usable at all.
- Neutral: this is worthless without client sink retention, because a client that rebuilds its
  decoder has no reference to receive a delta against.

Keeping the encoder alive forced a correction on the client side. The handover path originally
reset the decoder, which was right when every reconnect began with a keyframe and wrong the
moment one could begin with a delta: that reset clears the cached format description, and deltas
carry no parameter sets, so the first one would have been undecodable. It also flushes the
layer's queued samples, discarding the very references a delta encodes against. Only timing
state is reset now. If the host does fall back to a keyframe, it carries fresh parameter sets
and the decoder re-establishes from it, so keeping the old ones costs nothing.

### Confirmation

The capability findings above are reproducible with a standalone probe against
`VTCompressionSessionCreate` and `VTSessionCopySupportedPropertyDictionary`.

The behavioural confirmation is a device run showing a recovery frame in the hundreds of bytes
rather than hundreds of kilobytes, and no visual corruption across a handover.

An earlier draft made this conditional on first measuring whether
`AVSampleBufferDisplayLayer` releases decoder resources while idle. That gate was wrong twice
over and is dropped.

It is not measurable as stated: proving the decoder kept a reference across a gap requires a
frame after the gap that references one before it, and the host always opens a new encoder
session and sends a keyframe, so no such frame exists until this ADR is implemented.

More importantly it is not needed, because the failure is already caught on both sides. The
encoder references only acknowledged LTRs and emits an IDR when none qualify. The decoder path
already routes every failure -- `recoveredRequestKeyframe`,
`droppedMismatchedDimensionsRequestKeyframe`, `droppedPendingKeyframe`,
`formatDescriptionUnavailable` -- to `requestKeyframe`. So a delta whose reference has been
released fails cleanly and pulls a keyframe: the worst case is today's behaviour plus one round
trip, not corruption and not a hang. That is cheap enough to let the real system answer the
question the synthetic harness was going to approximate.

## Links

- ADR-0089 survive a network handover instead of waiting for the transport
- ADR-0073 freshness-first owned media
- ADR-0025 motion carrier
