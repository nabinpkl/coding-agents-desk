---
status: accepted
date: 2026-06-25
amends: ADR-0022 (multi-stream QUIC and progressive repaint), reviving its dropped copyRect half
---

# Revive a hardened, host-detected scroll copyRect

## Context and Problem Statement

ADR-0022 made two moves: split the QUIC connection into independent graphics and interactive streams (kept, proven), and delete pixel-guessed scroll on the premise that the content-addressed tile cache plus progressive repaint would carry scrolling. Device measurement after both landed shows the second premise is wrong for the common case.

The content cache keys a tile by the hash of its raw bytes, on a 128px grid. Smooth scrolling moves content 1 to 3 pixels per frame. A sub-tile shift gives every viewport tile new bytes (the content straddles grid lines differently each frame), so the hash misses and the whole viewport re-tiles every frame. Device logs during slow scroll showed `cacheHit` near zero and the link saturated at ~2 Mbps: the cache structurally cannot help a shift that is not a whole-tile multiple, which is every real scroll. The post-0022 path was measurably slower than the old copyRect baseline (tag `8e34514`) even for slow scrolls.

Two further defects compounded it. The periodic full-surface heal (added to scrub incomplete-damage cursor trails) flashed the screen black: the client's `.resetSurface` zeroed its framebuffer, and a `.drawCachedTile` for a slot the client lacked threw, forcing a generation reset that zeroed again. The heal amplified this roughly threefold.

ADR-0022 deleted copyRect partly because macOS no longer emits a move vector (`CGDisplayStreamUpdate` moved-rects was obsoleted in macOS 15; ScreenCaptureKit gives only dirty rects), so it judged scroll detection to be fragile pixel-guessing. That judgment conflated two things: inferring that a scroll happened and on which axis (genuinely unavailable from pixels) versus measuring the exact offset of a scroll the input layer already declared. The iPhone client originates the scroll, so the host already holds a truthful `MotionSignal {axis, sign}`. Only the magnitude is unknown, and it is recoverable from the surface and, critically, verifiable.

## Decision Drivers

- Scrolling is the daily-driver motion and must be cheap: a blit plus a thin exposed strip, not a whole-viewport re-tile per frame.
- Never ship a wrong blit. A misdetected offset that tears the screen is worse than a tile fallback.
- No black flash. A reset or a cache miss must degrade to slightly-stale, never to black.
- Keep everything ADR-0022 proved: multi-stream QUIC, progressive repaint, the content cache, and the periodic heal.
- Use the OS-given and input-given truths only (dirty rects, declared axis), never an input-to-pixel magnitude guess.

## Considered Options

- **Option A, client-predicted scroll**: the client applies the offset from its own gesture before the host confirms. Lowest latency, but the client guesses pixels the host has not validated, so a misprediction tears locally.
- **Option B, host-detected, content-verified copyRect (verify-or-fallback)**: the host uses the declared axis only to pick the search direction, measures the offset from the surface, and emits a blit only when a 2-D verify stripe confirms it; otherwise it tiles.
- **Option C, leave it as damage-tiles**: accept the slow scroll, keep tuning the cache and progressive repaint.

## Decision Outcome

Chose **Option B**. The earlier failure was inferring a scroll's existence and direction from pixels; measuring a declared scroll's offset and then proving it on the surface is a different, safe problem.

**Detection (host, content-verified).** `FrameComposer` uses `MotionSignal {axis, sign}` only to choose which axis and directions to search, never as an input-to-pixel magnitude. The revived `ScrollOffsetEstimator` finds candidate offsets by a 1-D luma-projection correlation along the axis, then accepts one only if a thin 2-D verify stripe over the overlap explains at least `hybridScrollOffsetVerifyFloor` (0.8) of its changed pixels. A non-translating repaint, two regions moving differently, or a wrong direction explains nothing and returns nil. On accept the composer emits `.scroll(region, dx, dy)`; otherwise it falls through to the existing tile or fullframe coverage path. Each frame is measured independently with no carried magnitude, so momentum, rubber-band, and variable per-frame offsets each either verify exactly or fall back.

**Emission (engine).** A `.scroll` builds one `copyRect` that shifts the stable region by the measured offset, then tiles only the thin newly-exposed strip through the existing rung-1/2/3 content-cache ladder and progressive splitter. So a scroll-back over seen content references cached slots (`drawCachedTile`, zero payload), a tall flick strip streams in bounded envelopes, and the strip's encoding is the same content-gated LZFSE or JPEG with no second downscale path. The `copyRect` is prepended to the first strip envelope. It is placed after the periodic-heal early return, so a heal-due frame still heals the whole surface during sustained scroll. A build failure recovers by tiling the band, never rejecting.

**Black-flash fix (client, two parts).** (A) A same-dimensions `.resetSurface` keeps the last-good pixels and only clears the slot cache and bumps the generation; the reset stripes or the next heal repaint over the slightly-stale frame. Only a genuine resize reallocates to black. (B) A `.drawCachedTile` for a missing or mismatched slot is skipped (pixels left as-is), not rejected; the periodic heal, which re-sends the whole surface, becomes the repair. Decode and stale-order guards stay fatal.

### Coherence argument

The host captures `current` (the OS has already shifted its framebuffer) and commits `pendingSurface = current`. On the client, `copyRect` shifts `pixels` by the same `(dx, dy)` over the same `region`; the strip overwrites the exposed remainder with `current`'s pixels; outside `region`, `current == previous` because damage covers all change. So the client's `pixels` end byte-identical to the host-committed `current`. Slots are content-addressed (FNV-1a over raw BGRA), so `copyRect` moves pixels, not slots, and the content-to-slot mapping stays identical on both peers, keeping a later `drawCachedTile` correct. This is asserted executably: a client compositor seeded with `previous`, fed the host's `copyRect` plus strip envelope, reproduces `current` byte-for-byte.

### Consequences

- Good, because sub-tile scroll ships a blit plus a sliver instead of a whole-viewport re-tile, the case the content cache structurally cannot serve.
- Good, because the verify floor makes a wrong offset impossible to ship: a frame that does not cleanly translate tiles instead, never tears.
- Good, because the heal stops flashing black and becomes the repair path for a skipped tile rather than a reset trigger.
- Good, because the multi-stream transport, progressive repaint, content cache, and heal from ADR-0022 are all kept.
- Bad, because the estimator and its five gates return as tuning surface; the verify floor is the single correctness knob and the rest are geometry gates.
- Bad, because `copyRect` re-enters the wire enum, a breaking change (free pre-v0; host and client ship together).
- Neutral, because horizontal scroll rides the same axis path; it is rarer and untuned beyond "works".

### Confirmation

- Host and client encode, decode, and validate the `.copyRect` command identically (codec round-trip tests, both targets).
- A confirmed scroll emits one `copyRect` plus an exposed strip that rides the cache ladder; a scroll miss tiles with no `copyRect`; the offset rides diagnostics (`acceptedBy=scroll`, `acceptedDx/Dy`). Unit-tested in the engine and composer.
- The client's `copyRect` blit is overlap-safe (shift-down and shift-up not torn, full-width fast path equals the row path), a same-dims reset keeps pixels, a resize reset zeroes, and a missing slot is skipped then repaired. Unit-tested in the compositor.
- A client seeded with `previous` and fed the host scroll envelope reproduces `current` byte-for-byte (round-trip coherence test).
- On `just iphone-console-run-dev`, slow and fast scrolls show `acceptedBy=scroll` frames with small payloads (blit plus thin strip, not a whole-viewport re-tile), `drawCachedTile` strip hits on scroll-back, no generation-reset storm, and no black flash on the rare reset. Compared against the copyRect baseline (tag `8e34514`).

## Pros and Cons of the Options

### Option A, client-predicted scroll

- Good, because it hides round-trip latency by moving content before the host confirms.
- Bad, because the client shifts pixels the host has not validated, so a misprediction tears locally with no verify gate to catch it.

### Option B, host-detected, content-verified copyRect

- Good, because it makes scroll cheap again while the verify floor guarantees a wrong offset never ships, and it keeps every proven ADR-0022 part.
- Bad, because it returns the estimator and its gates as tuning surface and re-adds a breaking wire command.

### Option C, leave it as damage-tiles

- Good, because it adds no code and keeps the wire frozen.
- Bad, because it leaves scrolling, the daily-driver motion, slower than the old baseline and bandwidth-bound, which the device disproves as acceptable.

## Links

- ADR-0022 multi-stream QUIC and progressive repaint, which this amends: its transport split, progressive repaint, content cache, and heal are kept; its decision to delete pixel-guessed scroll is reversed for the hardened, content-verified form.
- ADR-0021 damage-driven retained graphics and ADR-0016 scroll-first hybrid retained graphics, the lineage where copyRect first lived.
- Apple, ScreenCaptureKit `SCStreamFrameInfoDirtyRects` gives dirty rects but no move vector: https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects (no date verifiable).
- Apple, `CGDisplayStreamUpdate` moved-rects API, obsoleted in macOS 15: https://developer.apple.com/documentation/coregraphics/cgdisplaystream (no date verifiable).
- RFB protocol `CopyRect` encoding, the same blit-then-paint shape from a verified move: https://www.rfc-editor.org/rfc/rfc6143.html (2011-03).
