# Crisp CPU: before/after damage-gating (ADR-0036)

Measured 2026-07-01 on the streaming host (sim client paired over localhost).

## The original complaint and the real cause

The reported "~100% CPU" was the **Debug** host. A `sample` showed
`OwnedTileCodec.extractTileWithHash` (the per-tile hash loop) saturating four
cooperative threads. Root cause: in `-Onone`, `observe()`'s per-byte
`for i in 0..<n` loops lower to `IndexingIterator` protocol-witness dispatch, a
10x+ multiplier. Building **Release** alone dropped the host to ~32% and
`extractTileWithHash` left the profile entirely (the optimized loop is cheap).

So the headline 100%→~30% fix was Debug→Release. Damage-gating is the *further*
optimization: it stops `observe()` re-hashing the whole surface every ~100ms
window, which matters most for Debug and for localized/static screens.

## Baseline (pre-gating)

- Debug host: ~101% CPU, `extractTileWithHash` the dominant leaf (4 threads pegged).
- Release host: ~32% CPU, `videotoolbox` (HEVC encode) dominant, `extractTileWithHash` already 0 samples. `observe()` unconditionally hashed the full surface (~290 tiles at 128px grid) every crisp window regardless of what changed.

## After gating (Release, sha 970c1ac)

Scenario: heavily-churning capture (the Claude Code TUI + terminal being
captured animate the whole screen constantly — the adversarial case for gating,
and the only one measurable from inside the captured session).

- Total host CPU ~40%, still `videotoolbox`-dominated (video encode tracks screen
  motion; gating does not touch it). `extractTileWithHash` = **0 samples**;
  whole `processCrisp` subtree ~31 of ~3000 samples (~1%). `extractBGRA` = 0.
- Gating is live and correct. Over a 12s window, of 67 emitting crisp windows:
  - **37 windows hashed 1-25 tiles** (localized gated passes — the win),
  - 1 window 26-100 tiles,
  - 29 windows 101+ tiles = the periodic ~1/s full-surface heal **plus** genuine
    full-screen-change damage (terminal scroll → damage covers the whole surface
    → hashing everything is correct).

Interpretation: when change is localized, a gated window now touches a handful of
tiles instead of ~290; when the whole screen changes, it correctly still hashes
everything; a heal reconciles ~1/s. In Release the crisp hash was already cheap
relative to video encode, so the total-CPU delta is modest; the structural win
(crisp work is now damage-proportional, and a settled screen early-outs before
the convert+hash) is confirmed by the window distribution and the flat
`processCrisp` profile.

## Caveat

A truly static-screen number could not be captured: the host captures the same
display the Claude Code agent UI animates on, so the capture never goes idle from
inside this session. The static-screen early-out (no damage, nothing due → skip
convert+hash) is covered by unit behavior (`hasDueCandidates` + the transport
early-out) and the ADR; a clean static measurement wants a capture target that is
not the driving terminal.
