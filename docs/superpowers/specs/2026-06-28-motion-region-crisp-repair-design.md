# Motion-region crisp-repair over video

Date: 2026-06-28
Status: design, pending implementation plan
Revision: 2 (reuse-based architecture after codebase mapping)

## Problem

Under the current `alwaysVideo` media path, text is never pixel-perfect. Every region rides a lossy video codec, so static text reads soft. The adaptive ladder (ADR-0033) is smoothness-first: on a constrained link it spends raster resolution before fps, so the link settles at a reduced-resolution rung and text stays blurry even when nothing is moving. Recent staged-recovery work (commit 4341115) made the ladder climb back out of emergency, but the rung it climbs back to is still resolution-reduced, so the symptom (no crisp text after settling) persists. Raster downscale is the wrong lever for crispness; it is a smoothness lever.

The insight that reframes the fix: at rest, crisp is nearly free. A static screen at full resolution costs one keyframe, then inter-frames collapse to almost nothing. The expensive thing is full resolution during motion. So crispness should be priced against motion, not against link capacity, and it should be delivered by a separate mechanism from the video carrier.

## What we are building

A per-region crisp-repair layer over the existing full-surface video. The video keeps running as the always-live floor for every region (smooth, lossy). When a region goes static, the host sends a lossless crisp tile for it and the client paints that tile over the video for that region. When the region changes again, the client reverts that region to transparent so the live video shows through. Text becomes crisp shortly after motion stops, per region, while moving regions stay smooth.

This is the "crisp-repair layer (the combo)" that ADR-0026 named as the reversibility target and explicitly deferred ("No combo/repair mode exists yet"). It is the documented next step, triggered now that small-font legibility demands it.

## Architecture decision: reuse the dormant tile primitives, do not build a parallel stack

Codebase mapping found that most of this already exists, dormant under `always_video`. The clean architecture reuses the proven, model-agnostic primitives and builds only the genuinely new per-region orchestration. It does NOT mirror the scar-tissue orchestration that was shaped around the retired whole-frame scroll swap.

Reuse (proven halves of ADR-0022/0025, the "tiles at rest" path that was always the good part):
- `TileContentCache` (host): FNV-1a content hashing, slot assignment, dedup, pending/commit semantics.
- Tile pixel extraction and LZFSE lossless encode (currently in `ScrollDeltaEngine`; lift the reusable functions out, leave the scroll routing behind).
- `OwnedGraphicsCommand` wire vocabulary: `cacheTile`, `drawCachedTile`, `bitmapTile` already exist on both sides (host SharedTypes.swift:1614, client mirror). These ARE the crisp-tile commands.
- Client `OwnedSurfaceCompositor` + `surfaceLayer` (CALayer) paint path (OwnedMediaVideoSink.swift:227,238,268), already in the view tree.

Do NOT reuse / explicitly retire as part of this work:
- The whole-frame `visibleSurface` `.video`/`.tiles` mutually-exclusive `isHidden` toggle. Per-region crisp requires surfaceLayer and videoLayer visible simultaneously in different regions, which the toggle cannot express. Replaced by per-region transparency.
- `MotionGovernor` / `ScrollDeltaEngine` scroll-prediction routing. Crisp-repair classifies motion per tile by content-hash change, not by input-declared scroll state.
- The dead host tile-emission pump (no live consumer today).

Build clean and minimal:
- Host `RegionCrispController`: per-tile settle/motion policy over the captured surface and damage rects. Uses `TileContentCache` for hashing/dedup. Emits crisp tiles (`cacheTile`/`drawCachedTile`) for settled tiles and a revert command for changed tiles.
- One new `OwnedGraphicsCommand` variant: `revertTileToVideo(x,y,width,height)` (makes that surfaceLayer region transparent so video shows through). This is the only new wire type, versus the two new message types the first draft proposed.
- Client per-region compositing: `OwnedSurfaceCompositor` paints crisp tiles into `surfaceLayer` with the rest transparent; `surfaceLayer` is shown over `videoLayer` (not swapped). A reverted region clears to transparent.

## Decisions locked during design

1. Crispness is a motion-driven axis, fully separate from the capacity ladder (ADR-0033). The ladder keeps owning the video carrier's bitrate, fps, and raster scale for motion smoothness only. Raster scale is never a crispness lever again.
2. Per-region, not whole-frame. Motion and static regions are independent, so a looping video in one corner does not hold text soft elsewhere.
3. Crisp-repair over a full-surface video floor, not cropped sub-region video (ADR-0025 rejected cropped video for the coordinate-alignment seam). Video stays full-surface; crisp tiles paint on top per region.
4. The crisp channel is the reliable owned-graphics stream that ADR-0026 parked, reactivated. Verified: `QuicSessionClientTransport` already runs a reliable stream and the media datagrams together on one `NetworkConnection<QUIC>` (OS 26 target), so this is a stream on the existing connection, not a second connection. ADR-0026's "a reliable channel cannot coexist with datagrams" premise is obsolete on the current API.

## The coherence invariant (the crux)

The failure to prevent is showing stale text crisply, which is worse than current text shown softly.

> A region shows crisp only while its content is provably unchanged since the crisp tile was made, and the client provably holds that exact tile. Otherwise it shows video.

Video (datagrams) is always the live floor. Crisp (surfaceLayer tiles) is a best-effort sharpen. Loss or lag degrades a region to soft-but-current, never crisp-but-wrong.

Mechanism, over the ordered reliable graphics stream:
- The host's live capture per tile (fixed grid, hashed) is the single source of truth.
- Promote: a tile whose content hash is unchanged for the settle window gets a `cacheTile`/`drawCachedTile` for its current hash. Stream ordering guarantees the client holds the pixels before it is told to draw, so no separate ACK protocol is needed.
- Revert: the instant the host's capture sees a tile's hash change, it sends `revertTileToVideo` for that tile on the same ordered stream and resumes treating it as moving. The client clears that region to transparent in order.
- Dedup: `cacheTile` is sent once per content hash; a tile the client already caches is re-shown with `drawCachedTile` (slot reference) alone.

Residual window: a bounded interval equal to the revert command's stream latency where the old crisp tile could still show right after a change. The host biases against it by reverting eagerly (flip on the first changed frame, before encoding new video for that region) and promoting conservatively (only after the full settle window). For text this is sub-perceptible and the content shown is the prior crisp frame of the same region, never another region's content. Accepted bound, not a correctness hole.

## Modules

### Host
- `RegionCrispController` (new, small): per-tile settle/motion policy; consumes the captured surface + damage rects available in the encode pump; uses `TileContentCache`; emits `OwnedGraphicsCommand`s. Pure-logic core, unit-testable like `MediaQualityController`.
- Tile-extraction/LZFSE helpers: lift the reusable functions from `ScrollDeltaEngine` into a shared helper so `RegionCrispController` uses them without dragging in scroll routing.
- Reliable graphics stream: reactivate a host->client reliable `QUIC.Stream` carrying owned-graphics frames. Reuses existing `OwnedGraphics` frame framing.

### Wire (both SharedTypes copies; see SSOT note)
- Add `OwnedGraphicsCommand.revertTileToVideo(x,y,width,height)`. No other new wire types.

### Client
- Crisp stream intake in `QuicSessionClientTransport`: accept/open the reliable graphics stream, decode `OwnedGraphics` frames, feed `OwnedSurfaceCompositor`.
- `OwnedSurfaceCompositor`: support per-region transparency (alpha 0 where reverted), so `surfaceLayer` composites over `videoLayer` per region. Replace the whole-frame `visibleSurface` `isHidden` swap with always-on surfaceLayer carrying transparent-where-video regions.

## Interaction with the existing ladder

The ladder (ADR-0033) is untouched and keeps managing video smoothness. Because crispness no longer needs the high-resolution rungs, the ladder can stay smoothness-first without costing legibility. The 4341115 staged-recovery work remains valid; it now governs only the video carrier.

## SSOT note (surfaced debt)

`SharedTypes.swift` is duplicated between host (2409 lines) and client (2284 lines) and has already drifted (different sizes/timestamps). Adding a wire variant means editing both copies identically. This is a single-source-of-truth hazard. Recommended follow-up (out of scope for this feature, flagged): extract wire types into one shared source referenced by both Xcode projects. For this change we add the one variant to both copies and add a round-trip test on each side to catch drift.

## Scope

In scope (v1): per-tile crisp-repair over full-surface video; reuse of tile cache/encode/compositor; one new revert command; settle-based promotion; eager revert; ordered coherence; reactivated reliable graphics stream.

Non-goals: cropped per-region video; raster scale as a crispness lever; reviving the scroll-carrier routing or whole-frame swap; ROI/QP codec bit-allocation; full SharedTypes unification (flagged separately).

## Testing
- Host unit tests: `RegionCrispController` state machine. Settle promotes; any hash change reverts; unchanged hash dedups; never emits a draw for a hash differing from current capture (the invariant). Mirror `MediaQualityControllerTests`.
- Wire round-trip tests for the new `revertTileToVideo` variant, on host and client.
- Client unit tests: per-region transparency compositing; revert clears a region; cache dedup by slot/hash; ordered application.
- Device validation (gated on explicit go-ahead): crisp appears within the settle window after motion stops; no stale crisp under induced loss; motion stays smooth; rest bandwidth stays low. The real acceptance signal.

## ADR

ADR-0034: motion-region crisp-repair over video. Records: revive the tile-at-rest path (proven half) as a per-region crisp-repair layer; partially reverse ADR-0026's "retire tiles entirely" (Option C), scoped to rest only, never as a motion carrier; the reliable graphics stream is reactivated, justified by the `NetworkConnection<QUIC>` API supporting reliable streams and datagrams on one connection. Cross-link ADR-0025 (temporal-not-spatial, tiles-at-rest is the proven half), ADR-0026 (the retirement being partially reversed), ADR-0033 (the ladder, now smoothness-only).

## Open defaults to confirm at review
- Tile size: reuse `Config.hybridTileGridPx` (one grid, one hashing scheme).
- Settle window: 150 to 250 ms of unchanged hash before promotion (config knob).
- Crisp byte cap per window: spread a full-screen settle burst over a few windows so it cannot starve the video's congestion share (config knob).
