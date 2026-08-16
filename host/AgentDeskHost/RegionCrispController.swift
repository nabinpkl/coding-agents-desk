import Foundation
import AgentDeskWire

// ADR-0034 crisp-repair: per-tile settle/motion policy. Over a fixed grid, each tile
// is hashed every frame from the captured BGRA surface. A tile that holds the same
// content for the settle window is promoted to a crisp tile (cacheTile, or drawCachedTile
// when its content hash is already cached). A crisp tile is reverted to video the first time
// a pass re-hashes it and finds the content changed. The coherence invariant holds: a
// draw is only ever emitted in the unchanged branch, so the emitted hash always equals
// the hash just computed from the current capture. Video is the live floor; a tile that
// cannot be compressed simply stays on video and is counted, never shown stale.
struct RegionCrispConfig: Equatable {
    let tileGridPx: Int
    let settleWindowMs: Int
    let cacheSlots: Int

    // The cap on new cacheTile payload bytes is NOT here. It is passed per call, because it
    // is the smaller of a fixed per-chunk cap and whatever is left of the current second's
    // rate budget -- a value that changes every window and only the transport knows.
    init(tileGridPx: Int, settleWindowMs: Int, cacheSlots: Int) {
        self.tileGridPx = tileGridPx
        self.settleWindowMs = settleWindowMs
        self.cacheSlots = cacheSlots
    }

    static func fromConfig() -> RegionCrispConfig {
        RegionCrispConfig(
            tileGridPx: Config.hybridTileGridPx,
            settleWindowMs: Config.ownedMediaCrispSettleWindowMs,
            cacheSlots: Config.ownedMediaCrispCacheSlots
        )
    }
}

// Paces crisp sends so a large settle cannot flood the link. The crisp tiles ride the
// reliable graphics lane, which shares a QUIC connection with the video datagrams; an
// unpaced crisp stream serializes ahead of video and spikes its latency. The rule is a
// single per-second crisp byte ceiling, so a full-surface settle (e.g. a desktop switch)
// trickles out instead of bursting all at once.
//
// It deliberately does NOT gate on whether video is "busy". Which regions crisp is decided
// per-tile by RegionCrispController: a moving region never settles, so it never emits; only
// regions that actually went static emit, paced by this cap. A prior whole-frame in-flight
// gate was both wrong-grained (one in-flight frame, or a blinking cursor, suppressed crisp
// for the whole screen) and self-defeating (crisp runs right after a video send, when a
// frame is always in flight, so it never passed). The cap is the only link-protection here.
// A pure value type so the policy is unit-testable without the transport, lanes, or locks.
struct CrispPacingGate {
    let maxBytesPerSecond: Int
    private(set) var windowStartNs: UInt64 = 0
    private(set) var bytesInWindow: Int = 0

    init(maxBytesPerSecond: Int) {
        self.maxBytesPerSecond = max(1, maxBytesPerSecond)
    }

    // How many bytes this crisp window may still emit. Rolls the 1s rate window over by wall
    // time first. Zero means the second's budget is spent and the window should not run.
    //
    // This returns a BUDGET rather than a yes/no on purpose. The previous shape answered
    // "is there any budget left?", which let a window holding 127KB of a 128KB/s allowance
    // emit a whole further chunk: measured at 303KB inside one second, 2.4x the ceiling it
    // was supposed to enforce. On a cellular link whose knee sits near 150KB/s that burst is
    // more than the entire link, so video datagrams queue behind the reliable crisp stream
    // and the picture goes stale until it drains. Handing the caller the remaining budget
    // lets the window cap its own payload instead of discovering the overrun afterwards.
    //
    // Spending still happens in recordSent once the payload size is known; this only reports.
    mutating func remainingBudget(nowNs: UInt64) -> Int {
        let windowNs: UInt64 = 1_000_000_000
        if nowNs &- windowStartNs >= windowNs {
            windowStartNs = nowNs
            bytesInWindow = 0
        }
        return max(0, maxBytesPerSecond - bytesInWindow)
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
    // Crisp tiles reverted to video because a re-hash proved their content changed. Every
    // revert in the system is now one of these (ADR-0102): reverting is a decision only this
    // pass is entitled to make, because only it has looked at the pixels.
    private(set) var reconcileRevertCount = 0

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

    // Full-surface reconciliation (the coherence safety net). Visits every grid tile,
    // row-major, re-hashing each from the passed pixels. This catches OS-damage
    // under-reporting: a crisp tile whose content changed without a damage rect is only
    // ever caught here (the gated observe trusts crisp tiles it is not told changed).
    // Byte-for-byte the pre-split observe() behavior.
    mutating func healScan(
        pixels: Data,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        nowMs: Int,
        maxPayloadBytes: Int
    ) -> RegionCrispEmission {
        let grid = config.tileGridPx
        guard grid > 0, width > 0, height > 0 else { return .none }
        let surfaceDidReset = prepareSurface(width: width, height: height)

        var visit: [CellKey] = []
        var y = 0
        while y < height {
            var x = 0
            while x < width {
                visit.append(CellKey(x: x, y: y))
                x += grid
            }
            y += grid
        }
        return reconcile(
            cells: visit, pixels: pixels, width: width, height: height,
            bytesPerRow: bytesPerRow, nowMs: nowMs, surfaceDidReset: surfaceDidReset,
            maxPayloadBytes: maxPayloadBytes
        )
    }

    // Damage-gated reconciliation. Visits only the union of:
    //   (a) tiles overlapping any rect in `changedRects` (clamped + grid-snapped exactly
    //       like reactToDamage's walk), and
    //   (b) non-crisp cells whose settle window has elapsed (the due-for-promotion set).
    // Already-crisp tiles NOT in that set are trusted and not re-hashed, so crisp work is
    // damage-proportional. `changedRects` may be empty: then it is a promote-only pass over
    // the due candidates. The coherence invariant holds because every visited tile
    // (including promote candidates) is re-hashed from the passed pixels before any draw.
    mutating func observe(
        pixels: Data,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        nowMs: Int,
        changedRects: [PixelRect],
        maxPayloadBytes: Int
    ) -> RegionCrispEmission {
        let grid = config.tileGridPx
        guard grid > 0, width > 0, height > 0 else { return .none }
        let surfaceDidReset = prepareSurface(width: width, height: height)

        // (a) tiles overlapping the damage rects, clamped and grid-snapped.
        var keys = Set<CellKey>()
        for rect in changedRects {
            let clamped = rect.clamped(toWidth: width, height: height)
            guard clamped.area > 0 else { continue }
            var ty = (clamped.y / grid) * grid
            while ty < clamped.maxY {
                var tx = (clamped.x / grid) * grid
                while tx < clamped.maxX {
                    keys.insert(CellKey(x: tx, y: ty))
                    tx += grid
                }
                ty += grid
            }
        }
        // (b) non-crisp cells whose settle window has elapsed (due for promotion). A
        // first-sight cell with no state yet is not tracked, so it is picked up only via
        // damage (a) or a heal reconcile, matching the old baseline-then-settle cadence.
        for (key, state) in cells where state.crispHash == nil
            && nowMs - state.stableSinceMs >= config.settleWindowMs {
            keys.insert(key)
        }

        // Deterministic row-major visit order (sort by y then x), so byteRanges and the
        // per-frame slot budget behave identically regardless of Set iteration order.
        let visit = keys.sorted { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
        return reconcile(
            cells: visit, pixels: pixels, width: width, height: height,
            bytesPerRow: bytesPerRow, nowMs: nowMs, surfaceDidReset: surfaceDidReset,
            maxPayloadBytes: maxPayloadBytes
        )
    }

    // True iff any tracked non-crisp cell's settle window has elapsed. Non-mutating and
    // pixel-free: a cheap timestamp scan the transport uses to early-out of a promote-only
    // observe pass when nothing is due.
    func hasDueCandidates(nowMs: Int) -> Bool {
        for state in cells.values where state.crispHash == nil
            && nowMs - state.stableSinceMs >= config.settleWindowMs {
            return true
        }
        return false
    }

    // Apply the geometry-change reset (drop per-tile state + slot cache on a genuine
    // resize) and mark the surface observed. Returns whether a wire-level resetSurface is
    // needed this frame: only a genuine geometry change, never the first-ever observe (the
    // transport already sends one on lane attach, so the first frame suppresses it).
    private mutating func prepareSurface(width: Int, height: Int) -> Bool {
        var surfaceDidReset = false
        if width != lastWidth || height != lastHeight {
            cells.removeAll()
            cache.reset()
            surfaceDidReset = hasObserved
            lastWidth = width
            lastHeight = height
        }
        hasObserved = true
        return surfaceDidReset
    }

    // The shared per-tile decision core. Visits the given cells in the given order,
    // re-hashing each from the passed pixels and running the identical first-sight /
    // changed-revert / settle-promote logic for every one. healScan passes all grid cells;
    // observe(changedRects:) passes the damage+due union. Neither the per-tile decision,
    // the pending/commit staging, nor the emission shape depends on which method called in.
    private mutating func reconcile(
        cells visit: [CellKey],
        pixels: Data,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        nowMs: Int,
        surfaceDidReset: Bool,
        maxPayloadBytes: Int
    ) -> RegionCrispEmission {
        let grid = config.tileGridPx
        var commands: [OwnedGraphicsCommand] = []
        var payload = Data()
        // Cap new slot assignments per frame to the cache capacity. The cache cannot
        // hold more than `cacheSlots` distinct tiles, and assigning more than that in a
        // single frame would force the slot chooser into a collision fallback where two
        // tiles share a slot (wrong pixels shown crisply). Excess settled tiles stay on
        // the video floor this frame and retry next frame (deduping once committed).
        var assignsThisFrame = 0

        for key in visit {
            let x = key.x
            let y = key.y
            let w = min(grid, width - x)
            let h = min(grid, height - y)
            guard w > 0, h > 0 else { continue }
            guard let (tile, hash) = OwnedTileCodec.extractTileWithHash(
                from: pixels, surfaceWidth: width, surfaceHeight: height,
                bytesPerRow: bytesPerRow, x: x, y: y, width: w, height: h
            ) else { continue }

            guard var state = cells[key] else {
                // First sight: establish baseline, never emit on the same frame.
                cells[key] = CellState(hash: hash, stableSinceMs: nowMs, crispHash: nil)
                continue
            }

            if hash != state.hash {
                // Changed: eager revert if this tile was showing crisp.
                if state.crispHash != nil {
                    commands.append(.revertTileToVideo(x: x, y: y, width: w, height: h))
                    reconcileRevertCount += 1
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
            } else if assignsThisFrame >= config.cacheSlots || maxPayloadBytes <= 0 {
                // Out of fresh slots this frame, or this second's byte budget is already
                // spent: leave on the video floor and retry next window (dedups once
                // committed). Checked before compressing, so an exhausted budget costs
                // nothing. A zero budget still lets the caller run the window for its
                // payload-free reverts and cache hits, which is the whole reason the
                // transport no longer returns early on one.
                throttledCrispTileCount += 1
            } else if let compressed = OwnedTileCodec.compressLZFSE(tile) {
                // Prospective, not retrospective. This check used to read `payload.count >=
                // cap` BEFORE compressing, which admitted the tile that crossed the line and
                // let one window reach nearly double its cap -- measured at 62KB against a
                // 32KB cap, and 303KB inside one second against a 128KB/s ceiling. On a
                // cellular link whose knee sits near 150KB/s, that burst is more than the
                // whole link, and video queues behind the reliable stream carrying it.
                //
                // The cost is one LZFSE pass on a tile that is then declined, which is cheap
                // beside stalling the video lane. `payload.isEmpty` still lets a single
                // oversized tile through: a tile larger than the entire budget would
                // otherwise be throttled forever, never crisp and never diagnosable.
                if !payload.isEmpty, payload.count + compressed.count > maxPayloadBytes {
                    throttledCrispTileCount += 1
                    continue
                }
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

        // Slot assignments are staged in `cache` but NOT committed here. The transport
        // commits only after the emission is handed to an attached lane (commitEmission),
        // and discards otherwise (discardEmission). This keeps the host's slot model from
        // getting ahead of what the client received, which is what made the host emit a
        // drawCachedTile for a slot the client never got. See TileContentCache's contract.
        return RegionCrispEmission(commands: commands, payload: payload, surfaceDidReset: surfaceDidReset)
    }

    // Commit / discard the slot assignments staged by the most recent observe(), so the
    // host's slot cache rides the lane's delivery: commit when the frame was sent, discard
    // when there was no lane to receive it. Exactly one must be called per observe().
    mutating func commitEmission() { cache.commitPending() }
    mutating func discardEmission() { cache.discardPending() }
}
