# Motion-region crisp-repair over video

Date: 2026-06-28
Status: design, pending implementation plan

## Problem

Under the current `alwaysVideo` media path, text is never pixel-perfect. Every region rides a lossy video codec, so static text reads soft. The adaptive ladder (ADR-0033) is smoothness-first: on a constrained link it spends raster resolution before fps, so the link settles at a reduced-resolution rung and text stays blurry even when nothing is moving. Recent staged-recovery work (commit 4341115) made the ladder climb back out of emergency, but the rung it climbs back to is still resolution-reduced, so the symptom (no crisp text after settling) persists. Raster downscale is the wrong lever for crispness; it is a smoothness lever.

The insight that reframes the fix: at rest, crisp is nearly free. A static screen at full resolution costs one keyframe, then inter-frames collapse to almost nothing. The expensive thing is full resolution during motion. So crispness should be priced against motion, not against link capacity, and it should be delivered by a separate mechanism from the video carrier.

## What we are building

A per-region crisp-repair layer over the existing full-surface video. The video keeps running as the always-live floor for every region (smooth, lossy). When a region goes static, the host sends a lossless crisp tile for it and tells the client to show crisp for that region. When the region changes again, the client reverts that region to video. Text becomes crisp shortly after motion stops, per region, while moving regions stay smooth.

This is the "crisp-repair layer (the combo)" that ADR-0026 named as the reversibility target and explicitly deferred ("No combo/repair mode exists yet"). It is not a reopening of a closed decision; it is the documented next step, triggered now that small-font legibility demands it.

## Decisions locked during design

1. **Crispness is a motion-driven axis, separate from the capacity ladder.** The ADR-0033 ladder keeps owning the video carrier's bitrate, fps, and raster scale for motion smoothness. It no longer carries any responsibility for crispness. The raster-scale axis is purely a smoothness lever from here on.
2. **Per-region, not whole-frame.** Motion regions and static regions are treated independently, so a looping video in one corner does not hold text crisp elsewhere.
3. **Crisp-repair over a full-surface video, not cropped sub-region video.** ADR-0025 already rejected spatially cropping the video and compositing it beside tiles, because of the coordinate-alignment seam. The video stays full-surface (HEVC skip makes static areas near-free), and crisp tiles repair settled regions on top of it. This gives per-region crispness without the alignment seam.
4. **Crisp tiles travel on a reliable QUIC stream over the existing media connection.** Verified: `QuicSessionClientTransport` already runs a reliable `inputStream` and the media `datagrams` together on one `NetworkConnection<QUIC>` (OS 26 target). A crisp-tile channel is one more reliable `QUIC.Stream` on that same connection, not a second connection and not a revival of the parked reliable channel. QUIC stream independence means crisp tiles never head-of-line-block the video, and loss on crisp tiles only delays crisp tiles.

## The coherence invariant (the crux)

The failure to prevent is showing stale text crisply, which is worse than showing current text softly. The rule:

> A region shows crisp only while its content is provably unchanged since the crisp tile was made, and the client provably holds that exact tile. Otherwise it shows video.

The video datagram layer is always the live floor. Crisp is a best-effort sharpen on top. Loss or lag degrades a region to soft-but-current, never to crisp-but-wrong.

Mechanism, using the ordered reliable stream:

- The host's live capture is the single source of truth. Per region (a fixed grid tile), every captured frame the host knows that tile's content hash.
- **Promote to crisp:** when a tile's hash is unchanged for the settle window, the host sends `CrispTile(region, hash, pixels)` then `CrispDirective(region, show: crisp, hash)` on the same ordered stream. Ordering guarantees the client holds the tile before it is told to display it. No separate per-tile ACK protocol is needed.
- **Revert to video:** the instant the host's capture sees a tile's hash change, it sends `CrispDirective(region, show: video)` on the ordered stream and resumes treating the tile as moving. The client applies directives in order, so the crisp overlay for that region is removed in order with the change.
- **Dedup:** crisp tiles are keyed by content hash and cached client-side (`TileContentCache` shape). An unchanged tile is never resent; a tile whose hash the client already holds is promoted with a directive alone.

The client is a pure follower. It never decides on its own to keep a region crisp. It maintains per-tile state from the directive stream and composites: for each tile, show the cached crisp bitmap if state is crisp, else let the video show through.

Residual window and bias: there is a bounded interval equal to the directive's stream latency where, right after a change, the client could still show the old crisp tile before the `show: video` directive lands. The host biases against this by reverting eagerly (flip to video on the first changed frame, before encoding the new video for that region) and promoting conservatively (only after the full settle window). For text this window is sub-perceptible (a caret blink reverting to the same text, moving). Documented as an accepted bound, not a correctness hole, because the content shown is the prior crisp frame of the same region, never a different region's content.

## Architecture

### Host

- **`RegionCrispController` (new).** Consumes the per-frame damage rects and captured surface the encode pump already has. Maintains a fixed-grid map of per-tile content hash and state (moving / settling / crisp). Emits `CrispTile` and `CrispDirective` messages. Reuses `TileContentCache` for hashing and dedup, and the fixed grid-cell size already used by `ScrollDeltaEngine` for damage tiling.
- **Crisp stream.** A new reliable host-to-client `QUIC.Stream` opened on the media `NetworkConnection<QUIC>`, carrying `CrispTile` and `CrispDirective`. Crisp tile pixels are lossless (LZFSE, as `ScrollDeltaEngine` tiles already are).
- The video carrier (`OwnedMediaTransport`, the encode pump, `MediaQualityController`) is unchanged in behavior. It keeps producing full-surface video governed by the existing ladder.

### Wire (`SharedTypes`)

- `CrispTile { regionId, contentHash, pixels (LZFSE) }`
- `CrispDirective { regionId, show: .crisp(contentHash) | .video }`

Both ride the new reliable stream. No change to the datagram media frame format.

### Client

- **`CrispRepairSink` (new).** Receives the reliable crisp stream, caches tiles by content hash, maintains per-tile display state from directives.
- **Compositing.** A crisp overlay aligned to the video frame, drawn over `OwnedMediaVideoSink`'s `AVSampleBufferDisplayLayer`, painting cached crisp tiles where state is crisp and leaving the rest transparent so the video shows through. Tile coordinates map directly to surface pixels because both layers share the full-surface geometry (no cropping).

## Interaction with the existing ladder

The ladder (ADR-0033) keeps managing video smoothness during motion and is otherwise untouched. Because crispness no longer depends on reaching the high-resolution rungs, the ladder is free to stay smoothness-first without that costing text legibility. The staged-recovery work in 4341115 remains valid: it governs how the video carrier recovers smoothness, which is now its only job.

## Scope

In scope (v1):
- Per-tile crisp-repair over full-surface video.
- Reliable-stream crisp tiles with content-hash dedup.
- Settle-based promotion, eager video revert, ordered tile-then-directive coherence.

Non-goals (explicitly deferred):
- Cropped per-region video (rejected by ADR-0025).
- Using raster scale as a crispness lever (it stays a smoothness lever).
- Changing the ladder's internal recovery logic.
- ROI/QP bit-allocation inside the codec (an alternative per-region path we are not taking).

## Testing

- **Host unit tests (pure logic):** the per-tile state machine. Settle window promotes; any hash change reverts; unchanged hash dedups; a directive is never emitted asserting crisp for a hash that differs from the current capture hash (the invariant). Mirror the `MediaQualityControllerTests` style.
- **Wire round-trip tests** for `CrispTile` / `CrispDirective` encode/decode.
- **Client unit tests:** `CrispRepairSink` applies directives in order, holds-before-show ordering, cache dedup by hash, revert clears the overlay.
- **Device validation (gated on explicit go-ahead):** crisp text appears within the settle window after motion stops; no stale crisp under induced loss; motion stays smooth; rest bandwidth stays low. This is the real acceptance signal and unit tests cannot judge it.

## ADR

Write **ADR-0034: motion-region crisp-repair over video**. It refines ADR-0026: the single-datagram-carrier premise (a reliable channel cannot coexist) is obsolete on the `NetworkConnection<QUIC>` API the code now uses, and the crisp-repair layer ADR-0026 reserved is now built. Cross-link ADR-0025 (the temporal-not-spatial lesson) and ADR-0033 (the ladder, now smoothness-only).

## Open defaults to confirm at review

- **Tile size:** reuse `ScrollDeltaEngine`'s existing fixed grid-cell size for crisp tiles (one grid, one hashing scheme). Confirm that cell size is right for text legibility vs tile-count overhead.
- **Settle window:** propose 150 to 250 ms of unchanged hash before promotion. Tunable via config.
- **Crisp tile rate cap:** on a freshly settled full screen, many tiles promote at once. Propose a per-window cap on crisp-tile bytes so a settle burst cannot starve the video stream's congestion share, spreading promotion over a few windows.
