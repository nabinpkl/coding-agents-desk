import Foundation

// ADR-0034 crisp-repair: per-tile settle/motion policy. Over a fixed grid, each tile
// is hashed every frame from the captured BGRA surface. A tile that holds the same
// content for the settle window is promoted to a crisp tile (cacheTile, or drawCachedTile
// when its content hash is already cached). The instant a crisp tile's content changes
// it is eagerly reverted to video. The coherence invariant holds by construction: a
// draw is only ever emitted in the unchanged branch, so the emitted hash always equals
// the hash just computed from the current capture. Video is the live floor; a tile that
// cannot be compressed simply stays on video and is counted, never shown stale.
struct RegionCrispConfig: Equatable {
    let tileGridPx: Int
    let settleWindowMs: Int
    let cacheSlots: Int
}

struct RegionCrispEmission: Equatable {
    var commands: [OwnedGraphicsCommand]
    var payload: Data

    var isEmpty: Bool { commands.isEmpty }
    static let none = RegionCrispEmission(commands: [], payload: Data())
}

struct RegionCrispController {
    private struct CellKey: Hashable { let x: Int; let y: Int }
    private struct CellState {
        var hash: UInt64
        var stableSinceMs: Int
        var crispHash: UInt64?
    }

    private let config: RegionCrispConfig
    private var cache: TileContentCache
    private var cells: [CellKey: CellState] = [:]
    private var lastWidth = 0
    private var lastHeight = 0
    private(set) var droppedCrispTileCount = 0

    init(config: RegionCrispConfig) {
        self.config = config
        self.cache = TileContentCache(slotCount: max(1, config.cacheSlots))
    }

    mutating func observe(
        pixels: Data,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        nowMs: Int
    ) -> RegionCrispEmission {
        let grid = config.tileGridPx
        guard grid > 0, width > 0, height > 0 else { return .none }
        if width != lastWidth || height != lastHeight {
            cells.removeAll()
            cache.reset()
            lastWidth = width
            lastHeight = height
        }

        var commands: [OwnedGraphicsCommand] = []
        var payload = Data()
        // Cap new slot assignments per frame to the cache capacity. The cache cannot
        // hold more than `cacheSlots` distinct tiles, and assigning more than that in a
        // single frame would force the slot chooser into a collision fallback where two
        // tiles share a slot (wrong pixels shown crisply). Excess settled tiles stay on
        // the video floor this frame and retry next frame (deduping once committed).
        var assignsThisFrame = 0

        var y = 0
        while y < height {
            let h = min(grid, height - y)
            var x = 0
            while x < width {
                let w = min(grid, width - x)
                defer { x += grid }
                guard let tile = OwnedTileCodec.extractTile(
                    from: pixels, surfaceWidth: width, surfaceHeight: height,
                    bytesPerRow: bytesPerRow, x: x, y: y, width: w, height: h
                ) else { continue }
                let hash = TileContentCache.hash(tile)
                let key = CellKey(x: x, y: y)

                guard var state = cells[key] else {
                    // First sight: establish baseline, never emit on the same frame.
                    cells[key] = CellState(hash: hash, stableSinceMs: nowMs, crispHash: nil)
                    continue
                }

                if hash != state.hash {
                    // Changed: eager revert if this tile was showing crisp.
                    if state.crispHash != nil {
                        commands.append(.revertTileToVideo(x: x, y: y, width: w, height: h))
                    }
                    state.hash = hash
                    state.stableSinceMs = nowMs
                    state.crispHash = nil
                    cells[key] = state
                    continue
                }

                // Unchanged this frame.
                if state.crispHash == hash { continue } // already crisp
                guard nowMs - state.stableSinceMs >= config.settleWindowMs else { continue }

                // Settled long enough: promote to crisp.
                if let slot = cache.lookup(hash: hash, bytes: tile) {
                    cache.touch(slot: slot)
                    commands.append(.drawCachedTile(slot: slot, x: x, y: y, width: w, height: h))
                    state.crispHash = hash
                    cells[key] = state
                } else if assignsThisFrame >= config.cacheSlots {
                    // Out of fresh slots this frame; leave on video and retry next frame.
                    droppedCrispTileCount += 1
                } else if let compressed = OwnedTileCodec.compressLZFSE(tile) {
                    let slot = cache.assign(hash: hash, bytes: tile)
                    assignsThisFrame += 1
                    let offset = payload.count
                    payload.append(compressed)
                    commands.append(.cacheTile(
                        slot: slot, x: x, y: y, width: w, height: h,
                        compression: .lzfse,
                        byteRange: OwnedGraphicsByteRange(offset: offset, length: compressed.count)
                    ))
                    state.crispHash = hash
                    cells[key] = state
                } else {
                    // Compression failed: leave the tile on the video floor, but make the
                    // drop diagnosable rather than swallowing it (review M2/m6).
                    droppedCrispTileCount += 1
                }
            }
            y += grid
        }

        cache.commitPending()
        return RegionCrispEmission(commands: commands, payload: payload)
    }
}
