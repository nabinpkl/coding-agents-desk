---
status: accepted
date: 2026-08-19
supersedes: ADR-0036 (its staleness bound and the `processCrispDamage` backstop that bound relied on; the damage-gated observe plus periodic heal it decided stands)
---

# The crisp window keeps its own clock

## Context and Problem Statement

The crisp text overlay failed to clear. A region whose content changed kept showing the
previous glyphs, sometimes for a second, sometimes until something unrelated moved on screen.

`RegionCrispController` only reverts tiles it *visits*, and since ADR-0102 it is the only
thing entitled to revert at all. Which tiles a window visits comes from `CapturedVideoFrame.damageRects`.
The transport reached that damage through the encode drain: `processCrisp` was a tail call on
the encode of whatever frame arrived, behind a 100ms interval gate. Two consequences followed
that neither ADR-0036 nor ADR-0102 accounted for, and both are load-bearing.

**A window saw one frame's damage and discarded the rest.** Capture runs at up to 60fps and
the crisp interval is 100ms, so roughly five of every six frames returned at the interval gate
with their damage rects dropped on the floor. Nothing accumulated them. A tile that changed on
one of those frames was never visited, therefore never re-hashed, therefore never reverted.
The encode path drops more still: `enqueue` coalesces onto `state.latest`, and a nil encode
result skipped the crisp call outright.

**And the heal could not fire without a frame.** ScreenCaptureKit produces on change. Once the
screen settled after an update, there were no more frames, so no more windows, so no more
heals. The stale tile left by the change that *ended* the motion stayed stale indefinitely,
which is the reported symptom exactly.

There is a third, worse form. `observe`'s promote set includes every tracked non-crisp cell
whose settle timer elapsed, anywhere on the surface, while a gated window only re-renders the
damage bbox. A cell whose change rode a discarded frame kept a settled-looking timestamp and
was hashed from stale buffer bytes, so it was *promoted to crisp showing already-outdated
pixels*. The invariant in `RegionCrispController`'s header, that an emitted hash always equals
one just computed from the current capture, did not hold.

ADR-0036 named a backstop for exactly this window: "during that stretch, reverts still flow via
`processCrispDamage` on any non-empty damage." ADR-0102 deleted `processCrispDamage` and
nothing replaced it. Affects `OwnedMediaTransport.swift`, `OwnedMediaCrispConvert.swift`.

## Decision Drivers

- Staleness is a correctness property (ADR-0102's driver, unchanged). A crisp tile masking
  changed content shows the user pixels that are no longer true.
- A staleness bound that is stated must actually bind. ADR-0036's bound was one heal interval;
  in practice it was unbounded, because the thing that advances toward a heal was the thing
  that had stopped.
- Crisp CPU must stay proportional to what changed (ADR-0036's driver, unchanged). The fix
  must not reintroduce a full-surface rehash at video cadence.
- The video path must not pay for it. Crisp already ran inline on the encode drain.

## Considered Options

- **Option A**: Accumulate damage across frames, keep crisp on the encode drain.
- **Option B**: Give crisp its own timer, and accumulate damage across every captured frame.
- **Option C**: Keep the buffer continuously current by rendering each frame's damage as it
  arrives, so a window needs no frame at all.

## Decision Outcome

Chose **Option B**.

Option A fixes the sampling loss but not the starvation: no frames still means no windows and
no heal, so the unbounded case survives. It is the smaller half of one bug.

Option C is appealing because it makes the persistent BGRA buffer a true always-current mirror
and lets a window run with no frame in hand. It fails on the heal's actual job. The heal exists
because OS damage *under-reports*; an under-reported change is by definition one the incremental
renders never wrote into the mirror, so a heal reading that mirror would confirm stale bytes as
fresh. The heal needs a real capture buffer, and moving the convert to capture cadence would
also multiply it by the frame rate for no gain elsewhere.

Option B: `enqueue` records every captured frame's damage into a `CrispDamageAccumulator` and
retains the newest frame as the window's pixel source. A `DispatchSourceTimer` on its own serial
queue runs the window every `ownedMediaCrispMinIntervalMs`, takes the accumulated damage and the
retained frame under one lock, and otherwise runs the ADR-0036 pass unchanged. On a static
screen the retained frame *is* the current screen, so the heal remains meaningful with capture
silent.

Retaining one frame costs no extra capture buffer in the steady state: `encodeGate.latest`
already holds that same `CVPixelBuffer`, and the reference is replaced by the next captured
frame. `setWatchingVideo(false)` drops it along with the pending damage, so a post-uncover heal
cannot promote a pre-cover screen.

### Consequences

- Good, because the staleness bound ADR-0036 claimed now holds: one crisp interval for a
  reported change, one heal interval for an unreported one, and neither depends on capture
  still producing.
- Good, because the promote path's coherence invariant is restored. A due candidate is only
  hashed from buffer bytes whose region either was re-rendered this window or has had no
  reported damage since the last heal.
- Good, because crisp no longer runs inline on the encode drain, so a heal's full-surface hash
  cannot delay a video send.
- Bad, because the timer runs whether or not anything is happening. The idle cost is one lock,
  a counter, and an early-out; the heal still wakes a full-surface hash roughly once a second
  on a settled screen, which the frame-driven version got for free by never running.
- Bad, because crisp and encode can now run concurrently rather than serialized, so their CPU
  overlaps where it previously interleaved.
- Neutral, because damage is capped at `CrispDamageAccumulator.maxRects` before collapsing to
  its union bbox. A union only ever makes the pass visit more tiles, never fewer.

### Confirmation

`CrispDamageAccumulatorTests` pins accumulation across frames, take-clears-once, restore after
a bailed window, and the bounded collapse. The `crisp window` log line's `reverts=` counter is
where a regression would show: it should now be non-zero for a change that lands entirely
between two window boundaries, and the "stale glyphs after the screen settles" symptom should
not reproduce on a device run.

`ScrollDeltaEngine` is deleted in the same change. It also emitted
`cacheTile`/`drawCachedTile`/`revertTileToVideo` and was the *other* crisp-shaped path in the
tree, which made "why is the tile not clearing" harder to answer than it should have been. It
had no production caller left after ADR-0026 retired it in favour of the video path; only tests
and a comment calling it dormant. `FrameComposer` and its damage-scroll classifier went with it;
`PixelRect`, which happened to live in that file, moved to `PixelRect.swift`. The dead knobs
`hybridClassifierMaxTileCoverageRatio`, `hybridFrameSendBudgetBytes`, `hybridFullframeMaxWireBytes`,
`hybridTileBusyBytesPerPixel`, `hybridTileCacheEnabled`, `hybridTileCacheSlots`, and
`ownedMediaTileHealIntervalFrames` are gone, as is `OwnedTileCodec.extractTile`, which had only
tests left. The `bitmapTile` wire command now has no producer; removing it is a wire change
governed by the protocol version and is deliberately not bundled here.

## Pros and Cons of the Options

### Option A: accumulate damage, stay on the encode drain

- Good, because it is a small change and fixes the sampling loss completely.
- Bad, because the heal still cannot fire without a frame, so the unbounded stale case survives.

### Option B: crisp keeps its own clock

- Good, because window cadence stops depending on capture in both directions.
- Good, because it decouples a multi-millisecond heal from the video send path.
- Bad, because it pays an idle timer and a periodic heal on a screen where nothing is happening.

### Option C: keep the buffer current on every frame

- Good, because a window would need no retained frame at all.
- Bad, because the heal's whole purpose is catching changes damage did not report, and those
  are exactly the ones an incremental mirror never receives.
- Bad, because it moves the YUV->BGRA convert to capture cadence.

## Links

- ADR-0034 motion-region crisp-repair (the settle/promote policy this drives)
- ADR-0036 crisp observe is damage-gated with a periodic full-surface heal
- ADR-0102 a crisp tile is reverted by pixels, not by a rectangle (made this pass the only reverter)
- ADR-0026 video primary, retire the reliable channel (left `ScrollDeltaEngine` with no caller)
