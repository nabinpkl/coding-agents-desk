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
    // Cap on new cacheTile payload bytes per observe(). Excess settled tiles throttle and
    // retry next window, so a full-surface re-cache trickles out instead of one MB-scale
    // burst that would saturate the lane and stall video.
    let maxBytesPerWindow: Int

    init(tileGridPx: Int, settleWindowMs: Int, cacheSlots: Int, maxBytesPerWindow: Int = .max) {
        self.tileGridPx = tileGridPx
        self.settleWindowMs = settleWindowMs
        self.cacheSlots = cacheSlots
        self.maxBytesPerWindow = max(1, maxBytesPerWindow)
    }

    static func fromConfig() -> RegionCrispConfig {
        RegionCrispConfig(
            tileGridPx: Config.hybridTileGridPx,
            settleWindowMs: Config.ownedMediaCrispSettleWindowMs,
            cacheSlots: Config.ownedMediaCrispCacheSlots,
            maxBytesPerWindow: Config.ownedMediaCrispMaxBytesPerWindow
        )
    }
}

// Paces crisp sends so they never steal the link from motion. The crisp tiles ride the
// reliable graphics lane, which shares a QUIC connection with the video datagrams; an
// unpaced crisp stream serializes ahead of video and spikes its latency. Two rules:
//   - Yield while video has frames in flight (motion owns the link); crisp waits for an
//     idle moment, which is exactly when content has settled and is worth sharpening.
//   - Cap the cumulative crisp bytes per rolling second, so a large settle trickles out
//     instead of flooding the link the instant it goes idle.
// A pure value type so the policy is unit-testable without the transport, lanes, or locks.
struct CrispPacingGate {
    let maxBytesPerSecond: Int
    private(set) var windowStartNs: UInt64 = 0
    private(set) var bytesInWindow: Int = 0

    init(maxBytesPerSecond: Int) {
        self.maxBytesPerSecond = max(1, maxBytesPerSecond)
    }

    // May a crisp window emit now? Rolls the 1s rate window over by wall time first, then
    // gates on video idleness and the remaining byte budget. Returning true does not spend
    // budget; the caller spends it via recordSent once the payload size is known.
    mutating func mayEmit(inFlightVideoFrames: Int, nowNs: UInt64) -> Bool {
        let windowNs: UInt64 = 1_000_000_000
        if nowNs &- windowStartNs >= windowNs {
            windowStartNs = nowNs
            bytesInWindow = 0
        }
        if inFlightVideoFrames > 0 { return false }
        return bytesInWindow < maxBytesPerSecond
    }

    // Charge an emitted crisp payload against the current second's budget. Only fresh
    // cacheTile bytes count; reverts and cache hits are payload-free and pass 0 here.
    mutating func recordSent(payloadBytes: Int) {
        bytesInWindow += max(0, payloadBytes)
    }
}

struct RegionCrispEmission: Equatable {
    var commands: [OwnedGraphicsCommand]
    var payload: Data
    // True on the frame the captured surface geometry changed (resize, resolution step,
    // display re-arrangement). The controller drops all per-tile state and its slot cache
    // on such a frame, so the transport MUST send a fresh `resetSurface` before any later
    // tile lands, or tiles would composite against the client's stale geometry.
    var surfaceDidReset: Bool = false

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
    // Distinguishes the first-ever observe (which establishes a baseline and is NOT a
    // resize) from a later genuine geometry change. An explicit flag rather than reusing
    // `lastWidth == 0` as a sentinel, so the "never observed" meaning does not silently
    // depend on reset() happening to zero the dimensions.
    private var hasObserved = false
    // A settled tile whose pixels could not be LZFSE-compressed. A genuine, per-tile
    // failure that persists until the tile's content changes; non-zero means something
    // is wrong with the content or codec, not the cache size.
    private(set) var droppedCrispTileCount = 0
    // A settled tile that could not get a fresh cache slot this frame (more tiles
    // settled at once than the cache holds). Self-healing: it retries next frame and
    // dedups once committed. Expected under a small cache; grows per frame per excess
    // tile, so it is a tuning signal (raise cacheSlots), not an error.
    private(set) var throttledCrispTileCount = 0

    init(config: RegionCrispConfig) {
        self.config = config
        self.cache = TileContentCache(slotCount: max(1, config.cacheSlots))
    }

    // Drop all per-tile state and the slot cache. The caller (R6) must invoke this when
    // the media session (re)connects: the reliable graphics stream delivers in order or
    // the connection dies, so within a session commit-on-produce is safe, but a fresh
    // client starts with an empty slot cache. Resetting here keeps the host's view of
    // what the client holds from diverging across a reconnect, so crisp tiles
    // re-establish from a baseline instead of referencing slots the new client lacks.
    mutating func reset() {
        cells.removeAll()
        cache.reset()
        lastWidth = 0
        lastHeight = 0
        hasObserved = false
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
        var surfaceDidReset = false
        if width != lastWidth || height != lastHeight {
            cells.removeAll()
            cache.reset()
            // Only a genuine geometry change (not the first-ever observe) needs a
            // wire-level resetSurface; the transport already sends one on lane attach, so
            // suppress the redundant signal on the very first frame.
            surfaceDidReset = hasObserved
            lastWidth = width
            lastHeight = height
        }
        hasObserved = true

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
                } else if assignsThisFrame >= config.cacheSlots || payload.count >= config.maxBytesPerWindow {
                    // Out of fresh slots, or this window's byte budget is spent: leave on the
                    // video floor and retry next window (dedups once committed). The budget
                    // check reads the bytes already emitted this window, so the first
                    // over-budget tile is the last one sent and the rest throttle without
                    // paying for compression. This spreads a full-surface re-cache over many
                    // windows instead of one MB-scale burst.
                    throttledCrispTileCount += 1
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

        // Slot assignments are staged in `cache` but NOT committed here. The transport
        // commits only after the emission is handed to an attached lane (commitEmission),
        // and discards otherwise (discardEmission). This keeps the host's slot model from
        // getting ahead of what the client received, which is what made the host emit a
        // drawCachedTile for a slot the client never got. See TileContentCache's contract.
        return RegionCrispEmission(commands: commands, payload: payload, surfaceDidReset: surfaceDidReset)
    }

    // Eager revert (input latency): when the OS reports per-frame damage, immediately revert
    // any crisp tile the damage overlaps to the live video floor, on the video-frame cadence,
    // instead of waiting for the next (~100ms) hash pass. An opaque crisp tile otherwise masks
    // the live video update for up to one crisp interval, which reads as sluggish response to
    // input. Reverting to video is always coherent (video is the live floor), so an over-broad
    // damage rect costs only a momentary un-crispen, never staleness. Carries no payload.
    mutating func reactToDamage(_ damageRects: [PixelRect], nowMs: Int) -> [OwnedGraphicsCommand] {
        let grid = config.tileGridPx
        guard hasObserved, grid > 0, lastWidth > 0, lastHeight > 0, !damageRects.isEmpty else { return [] }
        var commands: [OwnedGraphicsCommand] = []
        for rect in damageRects {
            let clamped = rect.clamped(toWidth: lastWidth, height: lastHeight)
            guard clamped.area > 0 else { continue }
            var ty = (clamped.y / grid) * grid
            while ty < clamped.maxY {
                var tx = (clamped.x / grid) * grid
                while tx < clamped.maxX {
                    let key = CellKey(x: tx, y: ty)
                    if var state = cells[key], state.crispHash != nil {
                        let w = min(grid, lastWidth - tx)
                        let h = min(grid, lastHeight - ty)
                        commands.append(.revertTileToVideo(x: tx, y: ty, width: w, height: h))
                        state.crispHash = nil
                        // Restart the settle timer so re-promotion waits for the region to
                        // truly settle again rather than re-caching on the next pass.
                        state.stableSinceMs = nowMs
                        cells[key] = state
                    }
                    tx += grid
                }
                ty += grid
            }
        }
        return commands
    }

    // Commit / discard the slot assignments staged by the most recent observe(), so the
    // host's slot cache rides the lane's delivery: commit when the frame was sent, discard
    // when there was no lane to receive it. Exactly one must be called per observe().
    mutating func commitEmission() { cache.commitPending() }
    mutating func discardEmission() { cache.discardPending() }
}
