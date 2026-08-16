---
status: accepted
date: 2026-08-16
supersedes: ADR-0034 (its eager-revert mechanism only; the settle/promote policy stands)
---

# A crisp tile is reverted by pixels, not by a rectangle

## Context and Problem Statement

ADR-0034 gave the crisp path two ways to un-crispen a tile. `RegionCrispController.observe`/`healScan` re-hash a tile and revert it when the content genuinely differs. Separately, `reactToDamage` ran on every captured video frame and reverted any crisp tile that a per-frame OS damage rect merely *overlapped*, with no access to pixels — it exists earlier in the pump than the YUV-to-BGRA convert. Its stated purpose was input latency: a crisp tile is opaque, so it masks the live video under it, and waiting for the next crisp window (~100ms) to notice a change reads as sluggish.

Device measurement on a 5G-connected session showed that path emitting roughly 140 reverts per second, each one a visible flip from crisp to video and back on text that was not moving. This ADR decides whether damage rectangles are admissible evidence for reverting. Affects `RegionCrispController.swift`, `OwnedMediaTransport.swift`, `Config.swift`.

## Decision Drivers

- A revert that is wrong is not free: it un-sharpens text the user is reading, and the repair (a re-promotion at the next window) costs another command and another repaint.
- Staleness is a correctness property. A crisp tile masking changed content shows the user pixels that are no longer true, and no amount of cheapness justifies that.
- Host CPU is already the crisp path's dominant cost (~40% before this work), so any fix that pays CPU must earn it.
- Whatever is decided has to be measurable afterwards, not argued from intuition.

## Considered Options

- **Option A**: Keep the rect-only eager revert as ADR-0034 specified it.
- **Option B**: Verify before reverting — render just the overlapped tiles and re-hash them, reverting only those that truly changed, with a tile-count threshold above which it falls back to rect-only.
- **Option C**: Delete the eager revert; the ~100ms hash pass becomes the only thing entitled to revert.

## Decision Outcome

Chose **Option C**.

Option B was built and measured first, because the question "how many of these reverts are real?" had no answer without it. Instrumented on device, **94% of verified reverts were spurious** — 1,896 tiles whose pixels were unchanged against 118 that had genuinely changed. That settles the evidentiary question: an OS damage rectangle is a poor predictor of whether a tile's pixels moved, and reverting on one is wrong far more often than right.

The same measurement knocked out Option B as a shipping design. Verification only ran for 12% of reverts, because the tile-count threshold guarding its cost was exceeded almost constantly (401/s unverified against 54/s verified) — the "rare full-surface spike" the threshold was sized for turned out to be the ordinary case. Raising the threshold to cover it would mean converting and hashing most of the surface at video cadence, six times more often than the crisp pass already does, and the partial version had already moved host CPU from 40% to 49%. Paying more CPU to reach a conclusion the hash pass reaches anyway 100ms later is not a trade worth making.

Option A stays rejected by the 94% figure alone.

The cost accepted is bounded and small: a genuinely changed region can keep a stale crisp overlay for up to one crisp interval (~100ms) before the next gated window re-hashes it and reverts. The population that pays it is the confirmed-change rate, measured at 3.2/s.

### Consequences

- Good, because roughly 400 reverts/s and the ~398 redraws/s that existed only to undo them leave the stream entirely; both are commands on the reliable graphics lane that shares a QUIC connection with the video datagrams.
- Good, because the verification CPU is handed back, along with the eager path's own per-frame rect walk.
- Good, because there is now exactly one place that reverts a tile, and it is the one place that has looked at the pixels. Reverting becomes a decision that requires evidence.
- Bad, because a changed region under a crisp tile can show stale pixels for up to one crisp interval where it previously showed them for one video frame.
- Neutral, because ADR-0036's damage-gated `observe` is untouched: damage rects are still trusted to decide which tiles to *visit*, which is a cheap-if-wrong hint, as distinct from deciding what to *show*, which is not.

### Confirmation

`RegionCrispController.reactToDamage`, `crispTilesOverlapping`, the eager counters, `OwnedMediaTransport.processCrispDamage`, and `AGENTDESK_OWNED_MEDIA_CRISP_VERIFY_MAX_TILES` are all deleted; their absence is the compliance signal. The `crisp window` log line carries `reverts=`, fed solely by reconcile's proven-change branch, so any future revert source would have to justify itself against that single counter. The flicker's return would show as `redraw` climbing back toward the `fresh` count in the same line.

## Pros and Cons of the Options

### Option A: keep the rect-only eager revert

- Good, because a changed region un-crispens within one video frame (~16ms at 60fps) rather than one crisp interval.
- Good, because it costs only rect arithmetic, no pixels.
- Bad, because it is wrong 94% of the time, and each wrong decision is visible to the user as a flicker.
- Bad, because the repair traffic it generates rides the reliable lane, which head-of-line blocks video.

### Option B: verify before reverting

- Good, because it keeps the ~16ms latency while removing the false reverts, which is genuinely the best of both where it runs.
- Bad, because its cost scales with crisp tiles overlapped, and measurement showed damage routinely overlapping far more than a threshold can cheaply cover.
- Bad, because at a threshold high enough to matter it converts and hashes most of the surface at video cadence, duplicating work the crisp pass does 100ms later.

### Option C: delete it

- Good, because it removes a mechanism, a config knob, a counter set, and two categories of wire traffic.
- Good, because the remaining path already had to be correct on its own — the eager revert was never load-bearing for correctness, only for latency.
- Bad, because worst-case staleness on a reported change goes from one video frame to one crisp interval.

## Links

- ADR-0034 motion-region crisp-repair (introduced the eager revert this removes)
- ADR-0036 crisp observe is damage-gated with a periodic full-surface heal (damage still selects which tiles to visit)
- ADR-0101 the quality target is a number, not a name (same lesson: replace an assumption with a measurement)
