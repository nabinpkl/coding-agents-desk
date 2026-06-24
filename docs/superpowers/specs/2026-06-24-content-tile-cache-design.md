# Content-Addressed Tile Cache for the Owned-Media Graphics Path

Status: proposed
Date: 2026-06-24
Branch: codex/scroll-hybrid-retained-graphics

## Why

The product goal is a text-grade remote desktop for agent coding and CLIs over a thin link (~2 Mbps). Two properties are non-negotiable: smooth scroll and crisp text. The current path delivers neither under load.

The motivating failure: on a physical run, after sustained fast flicks the host re-sent a byte-identical 72-tile frame (`bytes=326194`) ten-plus times in a row. On a ~2 Mbps link each is ~1.3s of airtime, so that burst was ~13 seconds where the screen could not change because every frame carried pixels the client already had. The link saturated and the control socket dropped. The client never choked (`queueDepthBytes=0`, `stale=0` throughout); it stopped receiving because the host was spending the whole link re-sending content already on screen.

Root cause: macOS `SCStreamFrameInfoDirtyRects` reports regions that were redrawn but often come out pixel-identical. The classifier trusts "dirty," snaps the region to grid cells, and re-encodes and re-sends every cell, even though the retained surface the client mirrors already holds those exact pixels. Nothing dedupes against what the client already has.

This is the exact problem RDP's bitmap cache solves: never send the client pixels it already holds.

## Goals

- Never re-transmit a tile whose pixels the client already has, whether at the same position (in-place repaint) or a different position (scroll re-exposure, repeated UI/text).
- Keep changed text tiles lossless so text stays crisp. The cache's saved bytes are spent on quality, not surrendered to a quality-dropping congestion ramp.
- Land the feature on clean code: delete dead machinery and unify the duplicated tile-build paths first, so the cache intercepts one seam, not three.
- Stage the work so the freeze fix ships and is device-validated before the larger content-cache machinery.

## Non-goals

- Glyph or character-level caching (RDP glyph cache). Documented as a future arc with an extension point, not built here. Tile granularity is the unit.
- Re-tuning the congestion ramp. The ramp stays as the fullframe fallback. Its knobs are preserved and revisited post-cache with real data, not in this spec.
- Persistent (cross-session) cache. RDP's persistent bitmap cache survives reconnects; ours is in-session only. Cross-session persistence is out of scope.
- Migration scaffolding. Pre-v0, the wire is free to break; host and client are rebuilt together and external state is wiped. No decode fallback for the old shape.

## RDP alignment

RDP bitmap caching (MS-RDPEGDI / MS-RDPBCGR, Revision 2):

- Each cached bitmap gets a 64-bit key derived from a hash of its pixel contents. The key is a content hash.
- The server models what the client holds. To paint, it sends `CACHE_BITMAP` (pixels + cache index, "store this") or, if the content is already cached, `MEMBLT` (cache index + destination, "draw what you already have"). Identical content is never re-transmitted.
- Caches are organized as fixed-size cells; eviction reuses a cell.

Our adaptation, and where macOS changes the mapping:

- We already have a **retained surface**: the host keeps `previous` (the committed baseline) and the client mirrors it exactly. Omitting a tile is safe; the client keeps the prior pixels at that position and only zeros on `resetSurface`. So the in-place "same content, same position" case needs no cache reference at all: the host omits the tile and sends zero bytes, which is cheaper than RDP's `MEMBLT`.
- The position-independent case (content seen before, now at a different position) is RDP's `MEMBLT` win and is where a content-addressed cache and new wire commands earn their keep.

So the retained surface and the content cache are two indices over one set: the pixels the client already has. One is keyed by position, one by content hash.

Sources:
- [MS-RDPEGDI: Bitmap Caches](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/2bf92588-42bd-4527-8b3e-b90c56e292d2)
- [MS-RDPBCGR: Persistent Bitmap Caches](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/2da3e165-d1ba-4b65-8909-7a0f7f858d69)
- [MS-RDPEGDI: Cache Bitmap Rev2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/3c76f8fb-fcaa-4ca6-9d2e-3f449bdbed40)

## Architecture: one tile store, two indices, one decision ladder

Per dirty grid cell in the `.tiles` path, the host makes one decision:

```
cur = pixels(current, cell)
1. if pixels(previous, cell) == cur                       -> omit the tile
                                                              (client already shows it here; zero bytes)
2. else if slot = contentIndex[hash(cur)] and slotBytes[slot] == cur
                                                           -> drawCachedTile(slot, x, y, w, h)
                                                              (RDP MEMBLT; a few bytes)
3. else  slot = contentIndex.assignLRU(hash(cur))
         pendingSlotBytes[slot] = cur
                                                           -> cacheTile(slot, x, y, w, h, .lzfse, range)
                                                              (RDP CACHE_BITMAP; paint + store)
if no commands were produced                               -> .noChange
```

- Rung 1 needs no hash. It is a `memcmp` of the current cell against the retained baseline `previous`. Because `previous` always reflects the true committed baseline (post-scroll, post-reset, whatever produced it), rung 1 is sound without any position-cache invalidation logic. This rung alone fixes the freeze.
- Rungs 2-3 add the content index. Every hash hit is verified by `memcmp` against the stored slot bytes before it is referenced, so a 64-bit hash collision can never corrupt the screen; it falls through to rung 3. Correctness of text is the priority, so no hash is trusted blind.

Rung 1 is the first rung of the same ladder, not a throwaway hack: it establishes the per-cell decision seam that rungs 2-3 extend, and it is strictly cheaper than `MEMBLT` for the in-place case.

## Phase 0: Prefactor (delete dead code, unify the tile-build seam)

Land the cache on clean ground. This phase changes no feature behavior; `just check` stays green throughout.

### 0a. Delete dead code

- `codecTile` case in `OwnedGraphicsCommand`, `host/AgentDeskHost/SharedTypes.swift:1197`, plus the encoder/decoder stubs that reject it (around `SharedTypes.swift:1251`, `1286`, `1316`). No call site emits it. Safe.
- `host/AgentDeskHost/ScrollRegionTracker.swift` in full, plus `ScrollRegionTrackerProvider`, the `scrollRegionHintProvider` threading through `OwnedMediaTransport` and the encode pump (initialized around `OwnedMediaTransport.swift:440`), and `ScrollRegionTrackerTests.swift`. `scrollRegionHintProvider()` is plumbed but never invoked; the damage-driven path replaced it. Safe.
- Five unused viewport config knobs, `host/AgentDeskHost/Config.swift:438-457`: `hybridScrollViewportMinWidth`, `hybridScrollViewportMinHeight`, `hybridScrollViewportConfidence`, `hybridScrollViewportMinInsetPx`, `hybridScrollViewportOverlap`. No references outside Config. Safe.

### 0b. Unify the tile-build seam

Three functions independently do `tileData` extraction plus compression:

- `makeScrollEnvelope` (`ScrollDeltaEngine.swift:527`) builds copyRect + exposed-strip tile.
- `makeTileEnvelope` (`ScrollDeltaEngine.swift:741`) builds per-cell grid tiles.
- `makeJPEGFrameEnvelope` (`ScrollDeltaEngine.swift:806`) builds the fullframe tile.

Extract one builder:

```swift
// Host-internal compression choice. Distinct from the wire enum
// OwnedGraphicsTileCompression: this carries the JPEG quality/scale the host
// picks; the emitted command records only the resulting wire compression tag.
enum TileEncoding {
    case lzfse
    case jpeg(quality: Double, scale: Double)
}

// Returns nil if extraction/compression fails or the cell is empty.
private func buildTile(
    surface: Surface,
    rect: PixelRect,
    encoding: TileEncoding,
    payloadOffset: Int
) -> (command: OwnedGraphicsCommand, payload: Data)?
```

All three callers route through `buildTile`. The cache decision (Phase 1/2) then wraps exactly one seam: the per-cell loop in the tiles path calls the cache, which either returns nothing (omit), returns a `drawCachedTile` command, or calls `buildTile` and records the slot. The fullframe and scroll-strip callers keep calling `buildTile` directly with their existing compression choices.

### 0c. Update stale comments

The "future content-hash cache" comments at `Config.swift:310`, `ScrollDeltaEngine.swift:12`, and `ScrollDeltaEngine.swift:736` become accurate references to the now-live cache (cite the ADR opened for this work).

## Phase 1 (Stage 1): rung 1, retained-baseline tile skip

The freeze fix. No wire change, no new persistent state.

- In the unified per-cell loop, before building a tile, extract the corresponding cell from `previous` and `memcmp` against the current cell. If equal, skip the cell.
- If every dirty cell skips, return `.noChange` (the engine already has a `.noChange` kind; the pump sends nothing).
- `previous` is only valid when generation and dimensions match the current frame. On generation bump or size change, `previous` is nil or stale and no cell is skipped (full resend), which is correct.

Stage 1 ships and is device-validated: the identical-frame burst must collapse to one frame then `.noChange`, freeing the link.

## Phase 2 (Stage 2): rungs 2-3, content-addressed cache

### Wire (breaking; pre-v0, rebuild both)

Add two `OwnedGraphicsCommand` cases (the retired `codecTile` slot is reused conceptually, not its tag):

- `cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)` — paint to the retained surface at (x,y) and store the decoded bytes under `slot` on the client. RDP `CACHE_BITMAP`.
- `drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)` — blit `slot`'s stored bytes to (x,y). No payload. RDP `MEMBLT`. `width`/`height` are carried for validation against the stored slot.

The host owns all slot assignment via LRU. Eviction needs no message: reassigning a slot through `cacheTile` overwrites it on both sides at once. This is what removes the eviction-sync risk.

### Host: `TileContentCache`

A standalone unit (own file, unit-tested in isolation), not logic buried in the engine:

- `contentIndex: [UInt64: UInt16]` mapping content hash to slot, bounded to `Config.hybridTileCacheSlots`, LRU.
- `slotBytes: [UInt16: Data]` the committed bytes per slot (the host's mirror of what the client holds), used to verify hash hits by `memcmp`.
- `pendingSlotBytes` staged updates for the in-flight frame, applied on commit.
- API: `lookup(hash:bytes:) -> UInt16?` (returns a slot only if `slotBytes[slot] == bytes`), `assign(hash:bytes:) -> UInt16` (LRU, stages into `pendingSlotBytes`), `commitPending()`, `discardPending()`, `reset()`.

### Commit lifecycle (the macOS quirk that bites if ignored)

Slot updates follow the exact lifecycle as `previous`: staged at build, applied only in `commitPendingSurface()` on send success. If a frame is held at the backpressure cap (`OwnedMediaTransport.swift` ~line 983) or the send fails, the client never received it, so its slot updates are discarded. Otherwise a later `drawCachedTile` would reference bytes the client lacks and corrupt the screen. This mirrors the existing `pendingSurface` -> `commit` pattern one-to-one; `TileContentCache.commitPending()`/`discardPending()` are called from the same sites that commit or drop `pendingSurface`.

### Client: slot store in `OwnedSurfaceCompositor`

`OwnedMediaVideoSink.swift`:

- Add `slotBitmaps: [UInt16: TileBitmap]` (decoded BGRA per slot), bounded the same as the host.
- `cacheTile`: decode the payload, paint to the retained surface at (x,y), and store the decoded bytes under `slot` (overwriting any prior occupant, which is how eviction syncs).
- `drawCachedTile`: blit `slotBitmaps[slot]` to (x,y); if the slot is missing or its dimensions disagree, treat as a decode failure (the existing failure path requests a surface reset rather than painting garbage).
- `resetSurface`: clear `slotBitmaps` alongside zeroing the pixel buffer.

## Invalidation (Mac quirks)

- Generation reset / resize (`invalidateRetainedSurface`, `surfaceGeneration &+= 1`): host calls `TileContentCache.reset()`; client clears `slotBitmaps` on `resetSurface`. Both sides reset together.
- Scroll copyRect: rung 1 stays sound (it compares against the post-scroll `previous`). The content index is keyed by content, not position, so it survives the scroll. That is the point: re-exposed lines that were cached become `drawCachedTile` hits instead of re-sends. No content-index invalidation on scroll.
- dirtyRects false positives: rung 1 absorbs them.

## Crisp text under load (first-class rule)

`cacheTile` payloads are lossless LZFSE, never quality-dropped. The cache shrinks volume, so the congestion ramp fires less, so changed text tiles go out lossless instead of JPEG-blurred. The ramp's lossy quality and downscale stay confined to the fullframe fallback (video, window switch). Design rule, stated so the plan honors it: keep text on the tile+cache path where everything is lossless; fall to lossy fullframe only for genuine whole-screen change.

## Config (no hardcode; env-overridable in `Config.swift`)

- `hybridTileCacheSlots` (default 512) `AGENTDESK_HYBRID_TILE_CACHE_SLOTS`. Host/client memory = slots x maxCellBytes; at 512 x 64x64x4 that is ~8 MB each side.
- `hybridTileCacheEnabled` (default true) `AGENTDESK_HYBRID_TILE_CACHE_ENABLED`. Kill switch; false falls back to Phase 1 behavior (rung 1 only).
- Grid cell size reuses the existing `TileGrid` grid config; no new knob.

Hash: a fast 64-bit non-cryptographic hash (FNV-1a or xxHash64) over the cell BGRA. Strength is not load-bearing because every hit is `memcmp`-verified; the hash is only a bucket.

## Testing

`TileContentCache` unit tests (isolated):
- lookup miss on unseen hash; hit only when stored bytes match.
- forced hash collision (same hash, different bytes) -> lookup returns nil -> caller sends `cacheTile`. No corruption.
- LRU eviction reuses the oldest slot after `slots` distinct tiles.
- `commitPending` applies staged bytes; `discardPending` drops them.

`ScrollDeltaEngineDamageRoutingTests` additions:
- Stage 1 freeze regression: identical consecutive frame on the tiles path -> `.noChange`.
- Partial change -> only changed cells emitted, unchanged cells omitted.
- Content reappears at a new position within the cache window -> `drawCachedTile` referencing the prior slot.
- Novel content -> `cacheTile` with a fresh slot.
- Generation reset clears the cache -> next frame re-sends (no stale `drawCachedTile`).
- Held/failed frame -> `discardPending`; the next produced frame does not emit a `drawCachedTile` for an uncommitted slot.

Client compositor tests (`OwnedMediaVideoSink`):
- `cacheTile` stores and paints; `drawCachedTile` blits the stored slot.
- `drawCachedTile` for a missing slot triggers the reset path, not a paint of garbage.
- `resetSurface` clears `slotBitmaps`.

Device validation gates:
- Stage 1: the identical-frame burst collapses to one frame then `.noChange`; no multi-second freeze on sustained flicks.
- Stage 2: scrolling code/CLI text produces `drawCachedTile` hits in the host log; text stays crisp (tiles stay LZFSE); fullframe frequency and the congestion ramp's activation drop.

## Future arc (documented, not built)

RDP gets its crispest text from a glyph cache, caching individual characters. That needs text-region detection on a raw BGRA stream and sub-tile granularity. The extension point is the per-cell decision ladder: a glyph index would slot in ahead of rung 3, decomposing a text cell into cached glyph blits. Out of scope here; recorded so the tile-cache structure does not foreclose it.

## Staging summary

1. Phase 0 prefactor: delete dead code, unify `buildTile`, fix comments. No behavior change.
2. Phase 1: rung 1 baseline skip + `.noChange`. Ships, fixes the freeze, device-validate.
3. Phase 2: rungs 2-3 content cache, wire, client slot store, commit lifecycle. Device-validate.
4. Future arc: glyph cache, not built.
