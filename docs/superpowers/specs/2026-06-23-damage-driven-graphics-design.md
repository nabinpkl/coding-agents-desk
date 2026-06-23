# Design: damage-driven, single-channel graphics path (text-first, no HEVC)

Status: proposed design, brainstorm output. No product code changed to produce this.
Date: 2026-06-23
Branch: codex/scroll-hybrid-retained-graphics
Supersedes (in intent): the hybrid HEVC + pixel-diff scroll path that froze on R74.

Background research this design rests on: `docs/references/rdp-graphics-architecture.md` (RDP principles P1-P13, macOS damage facts M1-M5, all dated citations). Project-specific freeze analysis: `docs/rdp-alignment-readiness-review.md`.

## Goal and non-goals

**Goal.** A clean remoting path for text-first desktop content (terminals, editors, browsers reading text, UI chrome) that never freezes, by aligning with how RDP actually moves pixels: a retained client surface, copy orders for motion, encoded tiles only for genuinely-new content, all over one reliable channel, gated by frame acknowledgement.

**Non-goals (for now).**
- Smooth full-screen video or sustained animation. Explicitly out of scope. Such content may lag or look poor; it must not freeze the session.
- Photo-perfect image quality. Raw LZ4 tiles are the only encoding; a still-image codec is a deferred follow-up, not v0.
- RDP-style glyph caching or wavelet progressive refinement (P7, P13). Substituted later by a content-hash tile cache if needed.

## Why the previous path failed (one paragraph, for the reader)

The frozen path coupled two channels: a datagram HEVC media stream and the reliable graphics stream, both writing one client surface. To feed the graphics path a scroll vector it brute-force pixel-diffed captured frames (`ScrollDeltaProbe`, a -240..240 sweep) which ran synchronously in the encode pump, starved HEVC admission, and still accepted zero offsets. To stop the two channels starving each other, an admission/floor/hysteresis layer was bolted on. To stop that layer freezing, more was bolted on. On hardware: ~50 surface resets per scroll, 804 reset-stripe frames, 15MB tiles, a 358-frame client backlog, and black boxes mid-reset. Every layer existed to compensate for the layer beneath. This design removes the two root causes (the channel duality and the pixel-diff detector) rather than mediating them.

## Architecture

### One channel, one surface writer, one command set

All traffic on the existing reliable QUIC graphics channel using the existing `OwnedGraphicsCommand` wire (ADGC framing). The datagram media channel and HEVC are removed.

Command set:

| Command | Purpose | When | Cost |
|---|---|---|---|
| `resetSurface(w, h, scale)` | (Re)allocate the full client surface | Connect, display resize only | Once per session/resize |
| `copyRect(srcRect, dstPoint)` | Move pixels the client already holds (RDP P2) | Scroll, window move | A few coordinates |
| `bitmapTile(rect, lz4Bytes)` | Paint a changed tile, LZ4-compressed raw pixels (RDP P11) | Newly-exposed strip; any non-scroll change | Bounded to changed region |
| `beginFrame(id)` / `endFrame(id)` | Atomic logical-frame markers (RDP P4) | Wrap every update batch | Negligible |
| `ack(id)` (client to host) | Frame acknowledgement (RDP P5) | After client composites a frame | Negligible |

`resetSurface` never fires for content. This single rule eliminates the reset storm: in steady state the surface is mutated in place by `copyRect` and `bitmapTile`, never reallocated.

### Tiling: fixed 128x128 grid

`bitmapTile` rectangles snap to a fixed 128x128 grid in surface pixel space. Rationale:
- Bounds the tile count per frame regardless of damage shape.
- Stable tile identity is the prerequisite for a future content-hash tile cache (RDP P6): same grid cell + same content hash means "already resident, draw by reference." Damage-shaped tiles cannot be cached this way.
- `copyRect` stays pixel-exact (it is a blit; no grid needed).

A dirty rectangle from the OS is expanded to the set of grid cells it touches; each touched cell is one `bitmapTile`.

## The producer loop

Driven by ScreenCaptureKit frame delivery. Per captured frame:

1. **Status gate (M4).** Read `SCStreamFrameInfoStatus`. Act only on `complete`. Drop `idle`/`blank`. Never infer "screen static" from empty `dirtyRects` alone.
2. **Read OS damage (M1, M2, M3).** Pull `SCStreamFrameInfoDirtyRects` (pixel space, union of moved+redrawn), `contentRect` (points), `scaleFactor` (pixel-to-point). No pixel diffing of the framebuffer anywhere in the system.
3. **Pull input scroll delta (M5).** From the gesture/input channel, the accumulated scroll delta since the last produced frame gives a predicted axis and `dy`. This is the move vector macOS no longer exposes (`CGDisplayStream` had it, ScreenCaptureKit does not); we own it because the scroll originates on the iPhone client.
4. **Fuse damage with input (evolved `DamageScrollClassifier`).** Test whether shifting a band by the predicted `dy` explains the `dirtyRects` union (the existing `shiftExplainsChange` / explained-fraction metric). If explained above threshold:
   - Emit `copyRect` for the moved band (shift the retained pixels by `dy`).
   - Emit `bitmapTile` for the newly-exposed strip only (the grid cells the scroll revealed).
5. **Else (no scroll, or input does not explain the damage).** Emit `bitmapTile` for every grid cell touched by `dirtyRects`, LZ4-compressed.
6. **Wrap** steps 4-5 in `beginFrame(id)` / `endFrame(id)` so the client composites the batch atomically and flips at end-of-frame (no tearing, no mid-reset black boxes).

The fusion step is the only "intelligence" in the system, and it is corroboration (does input agree with OS damage), not search. There is no candidate sweep, no per-frame brute force.

## Backpressure: frame-ack flow control

This single mechanism replaces the entire deleted admission/floor/hysteresis/severe-mode layer.

- The producer holds at most **N unacked frames** (start N = 2).
- The client sends `ack(id)` after it composites a frame.
- When the producer is at the unacked cap, it does not produce. It waits.
- While waiting, screen changes accumulate in the OS. ScreenCaptureKit delivers `dirtyRects` as the union since the last consumed frame, so when an `ack` frees a slot, the producer emits one correct catch-up frame covering everything that changed, not a backlog of stale frames.

The previous freeze was only possible because nothing gated the producer on client progress. This gates it directly, with no heuristics and no queue-depth estimation.

## What changes in the codebase

### Delete (the bolted-on machinery)
- `ScrollDeltaProbe` (brute -240..240 pixel-diff sweep).
- `ScrollViewportTracker` and the `ScrollDeltaEngine` pixel-matching path.
- `HybridHEVCFallbackPolicy` and the admission / floor / hysteresis / severe-mode logic in `OwnedMediaTransport`.
- The HEVC encode path, the datagram media channel, and the client `OwnedHEVCFrameDecoder`.

Pre-v0, breaking changes are free (AGENTS.md), so these are deleted, not kept dormant. Recoverable from git if video work returns.

### Evolve
- `DamageScrollClassifier` becomes the damage+input fusion core (step 4). Its existing input-corroborated `shiftExplainsChange` metric and tests are the seed.

### Extend
- `ScreenCaptureKitFrameSource` reads `SCStreamFrameInfoDirtyRects` / `contentRect` / `scaleFactor` / `status` and carries damage on `CapturedVideoFrame`.

### Keep untouched
- QUIC transport, pairing, session tokens.
- The `OwnedGraphicsCommand` graphics wire (ADGC framing).
- `OwnedSurfaceCompositor` (the retained client surface, RDP P1).
- The input stack (`GestureTranslator`, `InputDispatcher`, `ScrollActivityTracker`, `NormalizedInput`).
- Spaces (`SpacesProvider`, `SpacesDotsView`).

## Components and boundaries

- **`ScreenCaptureKitFrameSource`** (extended): capture + damage extraction. Input: SCK stream. Output: `CapturedVideoFrame` carrying pixels + `dirtyRects` + `contentRect` + `scaleFactor` + `status`.
- **`DamageScrollClassifier`** (evolved): pure fusion. Input: dirtyRects + predicted scroll delta + previous surface state. Output: either a `copyRect` band + exposed-strip rects, or a list of redraw rects. No I/O, fully unit-testable (already has a test file).
- **Producer / command emitter** (new, replaces the `OwnedMediaTransport` pump): orchestrates status gate, classifier call, grid snapping, LZ4, frame markers, and the unacked-frame cap. Input: `CapturedVideoFrame` + input deltas + ack signal. Output: `OwnedGraphicsCommand` batches.
- **`OwnedSurfaceCompositor`** (kept): applies `copyRect`/`bitmapTile` to the retained surface, composites a logical frame on `endFrame`, sends `ack`.

Each unit answers: what it does, how it is used, what it depends on. The classifier and compositor are independently testable; the producer is the only stateful orchestrator and its state is just "frames in flight."

## Error handling and edge cases

- **Idle/blank frames (M4):** dropped at the status gate.
- **dirtyRects spans whole content (fast scroll, M2):** fusion fails to explain it as a single band, falls to full redraw of touched cells. Bounded by the unacked cap and tile grid.
- **Input says scroll but OS damage disagrees:** fusion rejects the copy, redraws the damaged cells. No bad copyRect is ever emitted (the corroboration gate prevents the wrong-offset artifacts the old probe produced).
- **Display resize:** `resetSurface` with new dimensions, the one legitimate full-surface event.
- **Client falls behind:** unacked cap stalls the producer; catch-up frame on next ack. No backlog.
- **Lost reliable frame:** the channel is reliable (QUIC), so ordered delivery is guaranteed; no datagram repair logic needed (another deletion).

## Testing

- **`DamageScrollClassifier`:** unit tests for fuse-accepts-scroll-when-input-corroborates, fuse-rejects-when-input-disagrees, fuse-falls-to-redraw-on-whole-content-damage, grid-cell expansion of dirty rects. Builds on the existing `DamageScrollClassifierTests`.
- **Producer:** unacked-cap stalls and resumes with a single union catch-up frame; `resetSurface` fires only on connect/resize; `beginFrame`/`endFrame` wrap every batch.
- **The five SPEC-tested modules** (Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView) are not touched destructively; their tests remain.
- **Device acceptance** (later, on implementation): `just fresh-hybrid-consoled-run` + `tools/hybrid-graphics-diagnostics-summary.sh`. Accept only if: no surface resets during scroll, `copyRect` is exercised during scroll, client render gap stays below the freeze threshold, and tile bytes stay bounded (no 15MB blasts).

## Open questions for implementation (not blockers)

- N (unacked cap) and tile size (128) are tunables; start at the stated values and measure.
- LZ4 vs a slightly stronger fast codec for tiles: start LZ4, revisit only if tile bytes dominate.
- Whether to delete the HEVC files in one commit or strangle incrementally behind the existing `AGENTDESK_HYBRID_DAMAGE_DRIVEN_SCROLL` flag is a plan-sequencing detail, decided in the implementation plan.

## What this design deliberately does NOT do

- No datagram channel, no streaming video codec, no per-frame pixel diffing, no candidate-offset search, no admission heuristics, no surface resets for content. Each absence corresponds to a confirmed failure mode of the previous path.
