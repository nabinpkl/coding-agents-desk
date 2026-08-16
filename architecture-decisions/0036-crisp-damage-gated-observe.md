---
status: accepted
date: 2026-07-01
---

# Crisp observe is damage-gated with a periodic full-surface heal

## Context and Problem Statement

`RegionCrispController.observe()` (host owned-media crisp path, ADR-0034) re-hashes every tile of the captured surface on every crisp window (~100ms), regardless of what changed. A `sample` of the streaming host shows the per-byte hash loop in `OwnedTileCodec.extractTileWithHash` saturating a core (Debug) / ~30% (Release) even when the screen is static. The capture pipeline already carries per-frame OS damage (`CapturedVideoFrame.damageRects`), which `reactToDamage` used for eager revert (since removed by ADR-0102, which found damage rects a poor predictor of actual pixel change), but `observe` ignores it. This ADR decides whether crisp change-detection may trust damage instead of a full-surface rehash. Affects `RegionCrispController.swift`, `OwnedMediaTransport.swift`, `Config.swift`.

## Decision Drivers

- Crisp CPU must be proportional to what changed, not to surface area, so a settled screen is ~free while streaming.
- Coherence is non-negotiable: a crisp tile must never show pixels that differ from the live capture for an unbounded time.
- ScreenCaptureKit damage is best-effort: it under-reports (a cursor move does not report the vacated pixels) and over-reports (redraws that produced identical pixels), and empty damage on a delivered frame means "extent unknown," not "nothing changed" (`ScreenCaptureKitFrameSource.swift`, `ScrollDeltaEngine.swift:240`, `FrameComposer.swift:118`).

## Considered Options

- **Option A**: Trust damage as the sole change signal; hash only damaged tiles, never a full rehash.
- **Option B**: Keep the full-surface rehash every window (status quo).
- **Option C**: Gate change-detection on damage plus due-for-promotion tiles, and keep a periodic full-surface heal that reconciles trusted crisp tiles, mirroring the tile path's existing heal.

## Decision Outcome

Chose **Option C**. Option A is unsafe: an under-reported change to an already-crisp tile would be shown stale forever, because nothing would ever re-hash it. Option B is the CPU regression being removed. Option C bounds the only staleness window to one heal interval and self-heals thereafter, which is exactly the tradeoff `ScrollDeltaEngine` already accepts for the same OS-damage limitation, so it introduces no new trust assumption. `observe` runs a gated pass (hash tiles overlapping damage for change detection, plus non-crisp tiles whose settle window elapsed for promotion; unvisited crisp tiles are trusted). The transport forces a full-surface heal pass every `ownedMediaCrispHealIntervalWindows` crisp windows, and skips crisp entirely (no YUV→BGRA convert, no hash) on a window with no damage and nothing due.

### Consequences

- Good, because a settled static screen does zero crisp hashing, and localized change costs scale with the damaged area.
- Bad, because a change to a crisp tile that OS damage under-reports can show stale until the next heal. The heal counter advances every crisp window, but the heal run (like all crisp emission) is behind the per-second pacing gate, so under a pacing-saturated settle the heal defers until the byte budget rolls over. Worst case is therefore roughly one heal interval plus up to ~1s of pacing rollover; during that stretch, reverts still flow via `processCrispDamage` on any non-empty damage. Accepted: reverting to video is always coherent (video is the live floor), so the cost is a momentary un-crispen, never wrong committed content.
- Neutral, because the promote path still re-hashes and verifies each tile before caching, so the cache/coherence invariant on emitted draws is unchanged.

### Confirmation

Unit tests on `RegionCrispController` pin the gated behavior (damage-gated revert, gated promotion of a due tile, trusted crisp tile not reverted without damage/heal, promote-time re-hash catching a missed change). A `sample`-based CPU measurement (docs/superpowers/measurements) shows the static-screen crisp CPU dropping to near-zero and `extractTileWithHash` leaving the static-case profile.

## Pros and Cons of the Options

### Option A

- Good, because it is the cheapest and simplest.
- Bad, because an under-reported change to a crisp tile is never reconciled: stale crisp is permanent, which violates the coherence driver.

### Option C

- Good, because CPU is damage-proportional and the staleness window is bounded and self-healing.
- Bad, because it keeps two code paths (gated + heal) and a heal-cadence knob to tune.

## Links

- ADR-0034 motion-region-crisp-repair
- `ScrollDeltaEngine.swift:240` (the tile path's existing periodic heal precedent)
- docs/superpowers/plans/2026-07-01-crisp-damage-gated-observe.md
