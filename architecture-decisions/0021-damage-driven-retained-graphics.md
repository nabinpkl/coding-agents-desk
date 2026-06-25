---
status: accepted
date: 2026-06-22
supersedes: ADR-0016 (scroll-first hybrid retained graphics), and transitively ADR-0015
---

# ADR-0021: Damage-driven retained graphics

## Context and Problem Statement

The scroll-first hybrid retained graphics path (the accepted scroll-first ADR, which itself superseded ADR-0015) froze on physical hardware. The host brute-force pixel-diff scroll detector runs a synchronous 960-candidate -240..240 sweep inside the encode pump (`ScrollDeltaProbe.swift:146,198`, `OwnedMediaTransport.swift:1021`), checks its 4 ms budget only after both loops finish (`ScrollDeltaProbe.swift:238`), and never accepts because coarse 10x8 sampling makes the 0.06 confidence margin structurally unsatisfiable (`ScrollDeltaEngine.swift:155-156`). Real logs: `accepted=0`, `blindTimeout=570`, client backlog 182 frames, `maxRenderGapMs=6096`, `baselineRealignments=256`. The decisive finding is that macOS ScreenCaptureKit already delivers per-frame damage via `SCStreamFrameInfoDirtyRects`, and the host drops all `SCStreamFrameInfo` attachments (`ScreenCaptureKitFrameSource.swift:135-155`), so the detector reinvents a signal the OS provides. This decision touches the capture source, the scroll detection stack (`ScrollDeltaProbe`, `ScrollDeltaEngine`, `ScrollActivityTracker`, `ScrollCopyOwnership`, `ScrollViewportTracker`, `ScrollRegionTracker`), and the host encode pump in `OwnedMediaTransport`.

## Decision Drivers

- The freeze must be eliminated by construction, not capped by budget tuning.
- The host must consume the OS-provided damage signal instead of recomputing it; detection cost should be O(damage), not O(frame).
- Scroll acceptance must not depend on selecting a winner among coarse near-ties.
- The retained surface must survive misses so the on-screen copy primitive can amortize.
- The client retained-surface compositor and the existing graphics wire shapes must not change, to keep blast radius on the host.
- The damage signal is best-effort and may be empty or coarse, so an encoded-pixel full-frame fallback must always exist.

## Considered Options

- **Minimal-patch the pixel-diff detector**: in-loop budget abort, denser sampling, absolute-confidence accept, wider hint window, baseline hold.
- **Damage-driven host classifier**: read `SCStreamFrameInfoDirtyRects`, verify one geometrically-implied offset, replace the brute-force stack with a per-frame chooser.
- **Ground-up rewrite**: the damage-driven core plus a broader restructuring of backpressure, caching, and migration.

## Decision Outcome

Chose the **damage-driven host classifier**. Read `SCStreamFrameInfoDirtyRects`, `contentRect`, `scaleFactor`, and `status` off each sample buffer in `ScreenCaptureKitFrameSource`, skip frames whose `status != .complete`, convert dirty rects from `contentRect`-relative points into native surface pixels with backing scale and a y-flip, and carry them on `CapturedVideoFrame`. A new pure `DamageScrollClassifier.classify(damageRects, contentRect, previous, current, hint)` returns `.scroll`, `.tiles`, or `.fullFrame` (`.noChange` is reserved for an upstream identical-frame short-circuit and is not emitted by `classify`).

Scroll is accepted only when the damage band spans most of `contentRect` width and clears a minimum height. The spike established that the dirty band is the **whole scrolled viewport** in native pixels, not a `|dy|`-height strip; `|dy|` is the exposed-strip *output* geometry the envelope builder derives, not an input gate, so the band height is not matched against `|dy|`. The input hint's predicted offset is approximate (input `dy` is not screen pixels once acceleration applies), so verification probes the predicted offset plus a small bounded neighbourhood of hinted offsets, closest-to-predicted first, over a thin centered sampled stripe (not the whole band). An offset is accepted when its shifted match is >= 0.90 **and** beats the no-shift (offset 0) match by a margin. There is no full-frame candidate sweep and no runner-up confidence margin (the structurally-unsatisfiable gate that froze the pixel-diff path); the only margin is best-vs-static, which rejects torn copies on low-detail or repetitive content. There is no 2-frame viewport streak.

Unmatched damage tile-encodes the damage rects, with the tile-vs-full-frame decision driven by summed rect area (not the union bounding box, so scattered small rects are not penalised). Empty or absent damage on a delivered frame falls back to full-frame HEVC, since a frame SCK chose to deliver changed by an unknown extent and skipping it would leave a stale screen.

The minimal-patch option was rejected as the permanent answer because it preserves an O(frame) worst case (the in-loop abort becomes load-bearing for correctness) and the absolute-confidence accept risks torn copies on low-detail content; it is adopted only as a first-commit hotfix that de-risks the migration. The ground-up rewrite was rejected because it widens the surface that must be re-proven without eliminating anything the classifier does not already eliminate.

This decision keeps HEVC as the full-frame rest and fallback path, keeps the client `OwnedSurfaceCompositor` and the `resetSurface/copyRect/bitmapTile` wire verbatim, keeps the graphics frame-ack queue-depth backpressure, and retires the five overlapping pixel-matching trackers into one motion-vector source.

### Consequences

- Good, because the synchronous 960-candidate sweep is deleted, so the pump can no longer starve HEVC admission and the multi-second render gap cannot recur by construction.
- Good, because verifying one geometrically-implied offset removes the unsatisfiable-margin failure at the root, so scroll accepts.
- Good, because the retained surface is realigned only on the rects an HEVC frame overwrote, never wholesale, so `copyRect` amortizes and the viewport streak can form.
- Good, because no wire shape and no client code change, so the migration is host-only with no persisted-state wipe.
- Bad, because the width-span ratio, minimum height, and best-vs-static margin are heuristics that can misfire on partial-window or overlay damage; provisional defaults are gated by the stripe verification and must be calibrated against the capture damage log before they are locked.
- Bad, because deleting five trackers and adding a capture-attachment path and two `CapturedVideoFrame` fields is a larger change than a four-line patch.
- Neutral, because the content-addressed bitmap cache and frame coalescing are deferred until move detection is proven; they do not pay before then.

### Confirmation

This decision is followed when:

- `ScreenCaptureKitFrameSource` reads `SCStreamFrameInfo` attachments and `CapturedVideoFrame` carries `damageRects` and `contentRectPixels`.
- The brute-force sweep (`bestOffset`, the -240..240 candidate loops), the confidence-margin constants, and `allowBlindScan` are deleted from the live path.
- Scroll acceptance is a bounded directed verification of the input-hinted offset (predicted plus a small neighbourhood) over a thin sampled stripe, gated by a best-vs-static margin, with a documented full-frame fallback when damage is empty or coarse.
- `baselineDecision` realigns only overwritten rects, and physical `just fresh-hybrid-consoled-run` logs show `viewport-locked copyRects > 0`, zero `probe-budget-exceeded`, and `maxRenderGapMs` back under the rest-state budget.
- Tests prove classification is O(damage) not O(frame), that a hinted scroll emits `copyRect` without any sweep, and that scroll misses do not realign the retained baseline.

## Pros and Cons of the Options

### Minimal-patch the pixel-diff detector

- Good, because it is small, reviewable, independently revertable, and stops the production freeze today.
- Good, because it keeps the correct copy, retained-surface, and framing primitives.
- Bad, because it preserves the O(frame) worst case and keeps the four overlapping trackers; the in-loop abort and the log-tuned thresholds become load-bearing for correctness.

### Damage-driven host classifier

- Good, because it eliminates the freeze class by construction and removes the unsatisfiable margin at the root.
- Good, because it consumes the OS damage signal the host currently drops, making detection O(damage), and reuses the already-correct copy path and wire.
- Bad, because it has a larger blast radius and relies on geometry heuristics gated by a single verification.

### Ground-up rewrite

- Good, because it shares the damage-driven core and its freeze elimination.
- Bad, because it widens the re-proven surface for no additional root-cause coverage.

## Links

- ADR-0016 scroll-first hybrid retained graphics, the decision this revision would supersede.
- ADR-0015 owned single-surface media baseline, superseded transitively.
- `docs/rdp-alignment-readiness-review.md`: the RDP/OS principle scorecard, redesign options, judge scores, and the minimal freeze fix this ADR draws from.
- `TASKS.md`: R74 corrected note and the damage-driven R75-R80 cluster.
- Apple ScreenCaptureKit `SCStreamFrameInfo.dirtyRects`: https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects (no date verifiable)
- MS-RDPEGFX `RDPGFX_SURFACE_TO_SURFACE_PDU` (the on-screen copy primitive): https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/0b19d058-fff0-43e5-8671-8c4186d60529 (2025-08-11)
