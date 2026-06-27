# Thin-link congestion tuning: lossy scroll strips + gentler quality ramp

**Status:** design, pre-implementation. Feeds the writing-plans skill next.

**Branch:** `codex/scroll-hybrid-retained-graphics`. Baseline tag `working-version-11` (commit 8e34514).

## Context

The owned-media graphics path is device-confirmed bandwidth-bound on a far/thin wifi link (~2 Mbps). Device measurement: ack latency scales with frame size (60-150KB -> ~650ms, >150KB -> ~1.1s), not a fixed RTT, so the in-flight window is correctly sized and the only lever that helps is fewer/smaller bytes. See `docs/references/rdp-graphics-architecture.md` for the RDP-alignment framing (this work is the P9/P13 adaptive-quality lever; the content-hash tile cache, P6, is a separate later iteration and is explicitly out of scope here).

`working-version-11` is the last device-confirmed-usable state: slow but no freezes, settles after backpressure. Two findings from that run set up this work:

1. The scroll path already emits a geometrically minimal exposed strip (`exposedHeight = |dy|`, full band width) but always as **LZFSE (lossless)**. On a fast flick over photo content the strip is a large lossless blob (device run: copyRect payloads up to 133KB). `host/AgentDeskHost/ScrollDeltaEngine.swift:563-564` (`compressLZFSE(exposed)`).
2. Congestion is a single boolean (`heldSinceLastProduce >= 1`) that cliffs quality straight to the q0.15 floor and scale to 0.5. Pushing the floor harder (0.35 scale / 120KB ceiling, ~q0.1) was reverted: a heavily-downscaled q0.1 JPEG upscaled on the client macroblocks into persistent "squares" on the retained surface. The floor (scale 0.5, q0.15) is a usability wall; the cliff is the structural problem.

## Goal

Cut what crosses the thin link without crossing the working-version-11 quality floor, via two cheap, mostly host-side levers:

1. **Lossy exposed scroll strips** - JPEG the exposed strip during motion/congestion instead of always LZFSE.
2. **Gentler congestion quality ramp** - replace the binary congested flag with a smoothed congestion level driving a monotonic quality/scale curve.

## Global Constraints

- No em-dashes in prose or comments (repo voice rule). Use commas, periods, or "and".
- No hardcoded configs. New tunables go through `Config` with an `AGENTDESK_*` env override, matching the existing `hybridFullframe*` entries.
- Iteration over compatibility (pre-v0): wire changes are free, but neither lever needs a wire-shape change (see below).
- The quality floor is fixed at the working-version-11 values: congestion scale never below `0.5`, congested JPEG quality never below `0.15`. The ramp changes only how we approach the floor, never crosses it.
- `just check` must stay green. New behavior gets unit tests in the existing host test targets (tests are written when a bug or behavior demands; both levers change observable encode behavior, so both get tests).
- Client requires no change for either lever: it already decodes any-size `.jpeg` bitmap tiles via the self-describing-dimensions path shipped in working-version-11 (`client/AgentDeskClient/OwnedMediaVideoSink.swift` `decodeJPEG`, accepts `image.width <= width, image.height <= height` and upscales).

## Lever 1: Lossy exposed scroll strips

### What changes

`makeScrollEnvelope` (`host/AgentDeskHost/ScrollDeltaEngine.swift:527`) keeps the `copyRect` command unchanged (moving the stable region is free and lossless). Only the exposed strip's compression becomes adaptive:

- **Lossless path (unchanged):** slow/small scroll on a calm link keeps the strip as one `.lzfse` bitmap tile. Crisp revealed text, and the strip is tiny anyway.
- **Lossy path (new):** when motion is active (`scrollHint != nil`) or the link is congested, encode the strip as a `.jpeg` bitmap tile, reusing the existing fullframe JPEG machinery: motion quality while scrolling, the congested floor plus 0.5 downscale when backed up. A fast flick's revealed band is large and motion masks the loss, so lossy is correct there.

### Trigger (the one real decision)

Lossy when `motion-active OR congested`, lossless otherwise. Rejected alternatives: "always lossy" needlessly blurs slow deliberate reading scrolls; "lossy only when congested" misses fast flicks on a momentarily-uncongested link.

### Plumbing

- `makeScrollEnvelope` gains the inputs it needs to decide: the congestion level (Lever 2) and a motion flag (`scrollHint != nil`). Both are available at the single call site in the `.scroll` branch of `evaluateWithDamage` (`ScrollDeltaEngine.swift:623`).
- The lossy strip reuses the existing helpers: `downscaleBGRA` (when the level calls for downscale) and `compressJPEGWithinBudget` with a strip wire budget. The strip tile is emitted with `compression: .jpeg` and the full destination width/height (self-describing JPEG dims), identical to `makeJPEGFrameEnvelope`.
- No new wire command. `.bitmapTile` already carries `compression`.

### Testing

- A motion scroll (hint active) emits a `.jpeg` strip whose payload is smaller than the same strip encoded as `.lzfse`.
- A slow scroll on a calm link still emits a `.lzfse` strip.
- The JPEG strip round-trips through the client decode path (CGImageSource into a top-down BGRA context) without a vertical flip, mirroring the existing `fullFrameJpegRoundTripPreservesOrientation` test.

## Lever 2: Gentler congestion quality ramp

### What changes

Replace the boolean `congested` (`host/AgentDeskHost/OwnedMediaTransport.swift:989`, `let congested = heldSinceLastProduce >= 1`) with a **congestion level** in `[0, 1]`, computed once per produce and threaded through `evaluate`/`evaluateWithDamage` in place of the boolean. Both the fullframe path and the Lever-1 strip path consume the level.

### Signal

`heldSinceLastProduce` (already computed in the encode pump), smoothed with a short EWMA so the level rises and falls gradually instead of snapping. Instantaneous level = `min(1, held / K)`, K around 8 (full saturation measured at ~14 holds/frame, so K=8 saturates a bit before the extreme). The EWMA state lives in the pump alongside `heldSinceLastProduce`.

Rejected alternative: a measured ack-latency/bandwidth estimate is more accurate but a larger build; this is the cheaper-levers bucket. The level is a clean seam to graduate to a measured estimate later without touching the encoder.

### Level to quality/scale mapping (in the engine)

- **Quality:** monotonic from the rest/motion baseline down to the q0.15 floor as the level climbs. A light backlog costs a little sharpness, not all of it.
- **Scale:** stays `1.0` until a mid threshold (level ~= 0.5), then ramps `1.0 -> 0.5`. Resolution is the heavy hammer reserved for sustained heavy congestion; it never drops below 0.5. Quality does the gentle early work.

Both map functions are pure (level -> Double), live in the engine next to the existing quality selection (`ScrollDeltaEngine.swift:677-682`), and are unit-testable in isolation.

### Config

Reuse the existing floor constants (`hybridFullframeJpegQualityRest/Motion/Congested`, `hybridFullframeCongestedScale = 0.5`). Add only what the ramp needs: the EWMA factor and the saturation K (or express K as the held-count that maps to level 1.0), each a `Config` entry with an `AGENTDESK_*` override and a default. No new floor constant; the floor is the existing congested values.

### Testing

- The level->quality and level->scale maps are monotonic.
- Level 0 yields rest quality and full resolution (scale 1.0).
- Maximum level yields exactly the floor (q0.15, scale 0.5), never below.
- A mid level lands strictly between baseline and floor for quality, and scale stays 1.0 below the mid threshold.
- EWMA smoothing: a single held frame does not jump the level to maximum (the cliff is gone).

## Out of scope

- Content-hash tile cache (RDP P6). Separate later iteration; the level seam and the lossy-strip path do not block it.
- Per-region text/photo codec split (RDP P9 full). Deferred; this spec keeps one codec per tile.
- Measured ack-latency/bandwidth estimation. The `heldSinceLastProduce` EWMA is the v1 signal.
- Any client-side change. Both levers are host-only.

## Verification

`just check` green, then a device run via `just host-run` (host-only, no client reinstall) on the thin-wifi setup, read with `tools/hybrid-graphics-diagnostics-summary.sh`. Acceptance signals:

- copyRect payload max/avg drop materially (the ~133KB strip tail collapses) without new copyRect tearing.
- No quality cliff: congested fullframes degrade and recover smoothly across a scroll burst, no persistent macroblock "squares".
- Generation stays stable (no reset regression) and effective fps is no worse than working-version-11.
