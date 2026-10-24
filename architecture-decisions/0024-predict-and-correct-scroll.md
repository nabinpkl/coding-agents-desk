---
status: superseded by ADR-0025
date: 2026-06-25
supersedes: ADR-0023
superseded-by: ADR-0025
---

# Predict-and-correct scroll (motion plus residual), replacing verify-or-fallback

## Context and Problem Statement

ADR-0023 revived a host-detected scroll copyRect gated on a 2-D verify stripe: the `ScrollOffsetEstimator` measured an offset and the engine emitted a blit only when the stripe explained at least `hybridScrollOffsetVerifyFloor` (0.8) of its changed pixels, otherwise it tiled the whole band. The gate is correct but the wrong shape for real content. A scroll on a Retina screen is never a pixel-exact translation, anti-aliased text and edges re-rasterize at every sub-pixel boundary, so the 0.8 floor almost always failed and the frame fell back to a whole-band re-tile at 50 to 80 KB. One device session over `<prefix>.AgentDeskHost` `owned-media` logged `acceptedBy=scroll` twice against 76 declared scrolls that missed. The black-flash fix from ADR-0023 held (generation stayed at 1), so this iteration is only about scroll weight. Touches `ScrollOffsetEstimator`, `ScrollDeltaEngine.makeScrollEnvelopes`, and the three gate knobs in `Config`.

## Decision Drivers

- Scrolling is the daily-driver motion and must be cheap on real content, not only on synthetic pixel-exact translations.
- No content-dependent correctness threshold. A gate that a normal Retina scroll fails is the defect, not the content.
- Never ship a wrong blit that tears, and never ship a frame heavier than today's whole-band tile.
- Use only the OS-given and input-given truths (dirty rects, declared axis), keep the proven ADR-0022/0023 parts (multi-stream QUIC, content cache, progressive repaint, heal, the `copyRect` wire command, the black-flash fix).

## Considered Options

- **Option A, keep verify-or-fallback and tune the floor**: lower `hybridScrollOffsetVerifyFloor` until real scrolls pass. A fragile per-content knob; too low ships tears, too high keeps missing.
- **Option B, predict-and-correct (motion plus residual)**: always apply the proposed shift as a copyRect, then diff `current` against the shifted-previous surface and tile only the residual (what still differs) through the existing tile ladder. The imperfect match is fine because the residual cleans it up.
- **Option C, go below ScreenCaptureKit for a move vector**: drop to a lower capture API to recover an OS-reported scroll delta. macOS 15 obsoleted moved-rects; there is no such API, and the input layer already declares the scroll.

## Decision Outcome

Chose **Option B**. The field never gates motion on a yes/no verify: HEVC Screen Content Coding (Intra Block Copy plus hash-based motion estimation), Microsoft's hash-based-ME and scrolling-detection patents, and TeamViewer's bitmap-delta lineage all do motion plus residual, copy the matched region and then encode only the pixels that still differ. We already owned both primitives, copyRect (the shift) and the tile ladder (which already sends only what changed); ADR-0023 wired them as either/or instead of one-then-the-other. Option A keeps the fragile knob the device disproved; Option C reaches for an API that does not exist to recover a truth the input layer already holds.

**Motion plus residual (the core).** On a declared scroll the engine builds `shiftedPrevious`, the committed `previous` surface with the copyRect applied, byte-identically to how the client's `copyRect` blit will transform its surface (same overlap-safe memmove, full-width fast path, exposed edge left stale). It then runs the existing `makeTileEnvelope(current, previous: shiftedPrevious, rects: [band])`: rung-1 omits every cell where `shiftedPrevious == current` (the cells the shift nailed, zero bytes) and tiles the rest (the exposed edge plus any sub-pixel-off cells) through the same content cache, JPEG/LZFSE, and progressive splitter. The copyRect is prepended to the first residual envelope. A good shift ships a blit plus a sliver; a bad shift ships the whole band (exactly today's cost), never worse.

**Did-it-help guard (makes no-floor safe).** After building the residual, if every band cell was tiled (the shift omitted nothing), the engine drops the copyRect and rebuilds as plain tiles against `previous`, labelled `scroll-no-shift-tiles`. This is a count-of-omitted-cells check with no magic number, the safety net that lets the proposer be liberal.

**Hash-based liberal proposer (replaces luma correlation plus verify).** The estimator stops measuring-and-verifying and proposes the dominant integer shift by row/column content hashing, the research's hash-based ME, reusing the slot cache's FNV-1a. For a vertical scroll it hashes each band row of `previous` and `current` over the band's cross extent; the offset that maximizes exact row-hash matches over the overlap is the dominant shift. An integer-pixel scroll keeps interior rows byte-identical so the correct offset wins by a wide margin, while sub-pixel-changed rows simply do not vote and the residual corrects them. Acceptance is one structural gate (a majority of the offset's overlap voting, plus an absolute coincidence floor of 8 matched bands), no luma tolerance, no verify floor. Direction is recovered from the surface, not the input delta, so the OS scroll-direction setting cannot flip it. The proposer no longer needs to be precise because the residual corrects its errors.

### Coherence argument

The client shows `previous`; its copyRect transforms its pixels to `shiftedPrevious`; the residual tiles, chosen by diffing `current` against `shiftedPrevious`, carry it to `current`. So `shiftedPrevious` is exactly the client's post-copyRect state, which is why the residual is correct. Slots are content-addressed (FNV-1a over raw BGRA), so copyRect moves pixels, not slots, and the content-to-slot mapping stays identical on both peers. This is provable host-side (copyRect plus residual over `shiftedPrevious` reconstructs `current`) and is covered by the existing client round-trip test, which extends from copyRect-plus-strip to copyRect-plus-residual unchanged.

### Consequences

- Good, because no content-dependent threshold survives: a real Retina scroll, which the 0.8 floor rejected, now ships a blit plus a thin residual instead of a 50 to 80 KB whole-band re-tile.
- Good, because the worst case is bounded: a useless shift is caught by the did-it-help guard and rebuilt as plain tiles, exactly today's cost, never a tear (the residual makes the pixels correct regardless of the shift's accuracy).
- Good, because six tuning knobs are gone (three dead strip knobs in Phase 0, the verify floor, verify extent, and luma tolerance here), leaving only two cheap band-geometry gates.
- Bad, because a genuinely sub-pixel (non-integer) scroll where no row matches exactly makes the proposer return nil and the frame plain-tiles, no worse than today's miss but not yet improved; a luma-correlation fallback proposer can be added later without touching the residual engine.
- Neutral, because non-band scattered damage is still dropped on a scroll frame and scrubbed by the periodic heal, pre-existing behavior, unchanged.

### Confirmation

- The estimator returns the dominant offset on content where a fraction of rows re-rasterized (the sub-pixel case the old floor rejected) and nil on a non-translating repaint, static, or sub-extent band. Unit-tested in `ScrollOffsetEstimatorTests`.
- A locally-imperfect scroll classifies `acceptedBy=scroll`, emits one copyRect, and tiles only the affected cells, not the whole band; a useless shift drops the copyRect. Unit-tested in the engine.
- Host-side, copyRect plus residual over `shiftedPrevious` reconstructs `current`; client-side, the round-trip test reproduces `current` byte-for-byte.
- On `just iphone-console-run-dev`, declared scrolls land `acceptedBy=scroll` with small `payloadBytes` (blit plus thin residual) instead of `tiles-scroll-miss` at 50 to 80 KB, `drawCachedTile` strip hits on scroll-back, no generation-reset storm, no black flash. Compared against the ADR-0023 build and the copyRect baseline (tag `8e34514`).

## Pros and Cons of the Options

### Option A, keep verify-or-fallback and tune the floor

- Good, because it is the smallest change and keeps the wire and estimator shape.
- Bad, because the floor is a per-content knob the device already disproved: any single value either ships tears or keeps missing real scrolls.

### Option B, predict-and-correct

- Good, because the residual makes an imperfect shift safe, so the proposer can be liberal and no correctness threshold is needed; both primitives already exist.
- Bad, because a non-integer scroll still falls back to tiles, and a wrong proposed shift wastes a small copyRect before the guard rebuilds (bounded and rare).

### Option C, go below ScreenCaptureKit

- Good, because an OS move vector would give the offset directly with no estimation.
- Bad, because macOS 15 obsoleted moved-rects and no replacement exists; it reaches below the capture layer for a truth the input layer already declares.

## Links

- SPEC §"ADR roll-call" and the ScrollDeltaEngine module note.
- ADR-0023 revive a hardened, host-detected scroll copyRect (verify-or-fallback), which this supersedes: its detection gate is replaced by predict-and-correct; its emission engine, the `copyRect` wire command, the coherence argument, and the black-flash fix are kept.
- ADR-0022 multi-stream QUIC and progressive repaint, and ADR-0016 scroll-first hybrid retained graphics, the lineage.
- HEVC Screen Content Coding, Intra Block Copy and hash-based motion estimation: ITU-T H.265 v4 SCC extension (https://www.itu.int/rec/T-REC-H.265, no date verifiable).
- Microsoft, hash-based block matching for motion estimation, US 9,153,207, and scrolling-region detection, US 11,095,877 (https://patents.google.com/patent/US9153207B2, no date verifiable).
- RFB protocol `CopyRect`, the blit-then-paint shape from a verified move: https://www.rfc-editor.org/rfc/rfc6143.html (2011-03).
