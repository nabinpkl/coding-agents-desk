# Content-Addressed Tile Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop the host re-sending tiles the client already holds, by adding an RDP-aligned content-addressed tile cache as one per-cell decision ladder, landed on prefactored code.

**Architecture:** Per dirty grid cell the host decides: omit if the retained baseline `previous` already shows these exact pixels (rung 1); `drawCachedTile` if the content is in a host/client-mirrored hash-keyed LRU (rung 2); else `cacheTile` to paint and store (rung 3). The retained surface and the content cache are two indices over the pixels the client already has. Cache commits ride the existing `commitPendingSurface()` send-success gate.

**Tech Stack:** Swift, two Xcode targets (`host/AgentDeskHost`, `client/AgentDeskClient`), XCTest, `just check`. LZFSE (`Compression`), CoreGraphics JPEG, vImage. Wire is the JSON-coded `OwnedGraphicsCommand`.

## Global Constraints

- No em-dashes anywhere; use commas, periods, or "and". No emoji. Postmortem voice.
- No hardcoded config: every tunable is a `Config.swift` static with an `AGENTDESK_`-prefixed env override, matching the existing pattern. Two `Config.swift` exist (host and client); add a knob to whichever target reads it.
- `SharedTypes.swift` is duplicated: `host/AgentDeskHost/SharedTypes.swift` and `client/AgentDeskClient/SharedTypes.swift`. Any wire change (`OwnedGraphicsCommand` enum, `Kind`, `CodingKeys`, `validateForCurrentScope`, `Codable`) is applied to BOTH copies identically.
- Cached and changed text tiles stay lossless LZFSE. The lossy quality/downscale ramp is confined to the fullframe fallback. Do not lower the existing quality floor (congestion scale never below 0.5, congested JPEG quality never below 0.15).
- TDD: failing test first for new behavior. For deletions and refactors the existing suite is the safety net; run it before and after.
- `just check` must be green before every commit. Commit each task as one logical unit and push to `origin/codex/scroll-hybrid-retained-graphics`.
- Every commit message ends with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Pre-v0: the wire may break; host and client are rebuilt together. No migration or old-shape decode fallback.
- Reference spec: `docs/superpowers/specs/2026-06-24-content-tile-cache-design.md`.
- Line numbers below are from the pre-prefactor tree and drift as tasks land; anchor on function and symbol names.

---

## Phase 0: Prefactor (no behavior change)

### Task 1: Delete the dead `codecTile` wire case

**Files:**
- Modify: `host/AgentDeskHost/SharedTypes.swift` (enum `OwnedGraphicsCommand` ~1193-1320)
- Modify: `client/AgentDeskClient/SharedTypes.swift` (same enum)
- Modify: `client/AgentDeskClient/OwnedMediaVideoSink.swift:382-383` (the `.codecTile` switch arm)

**Interfaces:**
- Produces: `OwnedGraphicsCommand` with cases `resetSurface`, `copyRect`, `bitmapTile` only.

- [x] **Step 1: Confirm no live emitter**

```bash
grep -rn "codecTile" host client
```
Expected: only the enum case, its `Kind`, the two codec `throw`s, the `validateForCurrentScope` `throw`, and the client `OwnedMediaVideoSink.swift:382` arm. No constructor that emits `.codecTile`.

- [x] **Step 2: Remove the case from both `SharedTypes.swift`**

In each file delete: the `case codecTile` enum member; the `case codecTile` in `enum Kind`; the `case .codecTile: throw SessionRejected(reason: .malformed)` arms in `validateForCurrentScope`, in `init(from:)`, and in `encode(to:)`.

- [x] **Step 3: Remove the client compositor arm**

In `client/AgentDeskClient/OwnedMediaVideoSink.swift`, delete:

```swift
            case .codecTile:
                throw SessionRejected(reason: .malformed)
```

The `switch command` over `OwnedGraphicsCommand` is now exhaustive over the three real cases.

- [x] **Step 4: Run the suite**

Run: `just check`
Expected: PASS. If any test referenced `.codecTile` as an expected-malformed input, delete that test case; a removed enum member cannot be constructed.

- [x] **Step 5: Commit**

```bash
git add host/AgentDeskHost/SharedTypes.swift client/AgentDeskClient/SharedTypes.swift client/AgentDeskClient/OwnedMediaVideoSink.swift
git commit -m "refactor: delete dead codecTile wire case

Vestigial enum member from a pre-damage-driven architecture; no emitter,
both codecs and the validator reject it. Removing it before the cache adds
real new command kinds keeps the wire surface honest.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 2: Delete the dead `ScrollRegionTracker` machinery

**Files:**
- Delete: `host/AgentDeskHost/ScrollRegionTracker.swift`
- Delete: `host/AgentDeskHostTests/ScrollRegionTrackerTests.swift`
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift` (the `scrollRegionHintProvider` threading and `ScrollRegionTrackerProvider`, around the factory near line 440 and the encode-pump constructor parameters)
- Modify: `host/AgentDeskHost.xcodeproj/project.pbxproj` (remove the two file references)

**Interfaces:**
- Produces: `OwnedMediaTransport` and the encode pump with no `scrollRegionHintProvider` parameter or stored property.

- [x] **Step 1: Map every reference**

```bash
grep -rn "ScrollRegionTracker\|scrollRegionHintProvider\|ScrollRegionFocusHint\|ScrollRegionTrackerProvider" host
```
Expected: the file itself, its test, a provider type, a stored/passed `scrollRegionHintProvider` in `OwnedMediaTransport` and the pump constructor, and the factory wiring. Confirm `scrollRegionHintProvider()` is never invoked (no call site reads its return).

- [x] **Step 2: Delete the two files and their pbxproj references**

```bash
git rm host/AgentDeskHost/ScrollRegionTracker.swift host/AgentDeskHostTests/ScrollRegionTrackerTests.swift
```
Then remove the matching `PBXBuildFile` and `PBXFileReference` lines for both files in `host/AgentDeskHost.xcodeproj/project.pbxproj`, and their entries in the Sources build phase and group children. Search the pbxproj for `ScrollRegionTracker` and delete every matching line.

- [x] **Step 3: Remove the threading in `OwnedMediaTransport.swift`**

Delete the `scrollRegionHintProvider` parameter from the `OwnedMediaTransport` initializer and the encode-pump constructor, the stored property, the `ScrollRegionTrackerProvider` instantiation in the factory, and every site that passes it through. The encode pump never consumed it, so no replacement value is needed.

- [x] **Step 4: Build and test**

Run: `just check`
Expected: PASS. Compiler errors point to any missed reference; remove each.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete unused ScrollRegionTracker machinery

The damage-driven path (ADR-0021) replaced viewport/region streak tracking.
scrollRegionHintProvider was plumbed through the transport and pump but never
invoked. Removing the dead file, provider, threading, and test before the
cache lands keeps the encode path readable.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 3: Delete the 5 unused viewport config knobs

**Files:**
- Modify: `host/AgentDeskHost/Config.swift:438-457`

**Interfaces:**
- Produces: `Config` without `hybridScrollViewportMinWidth`, `hybridScrollViewportMinHeight`, `hybridScrollViewportConfidence`, `hybridScrollViewportMinInsetPx`, `hybridScrollViewportOverlap`.

- [x] **Step 1: Confirm no references outside Config**

```bash
grep -rn "hybridScrollViewportMinWidth\|hybridScrollViewportMinHeight\|hybridScrollViewportConfidence\|hybridScrollViewportMinInsetPx\|hybridScrollViewportOverlap" host client
```
Expected: only the five definitions in `Config.swift`. No reader.

- [x] **Step 2: Delete the five `static let` definitions and their env-parse lines**

Remove each of the five properties at `Config.swift:438-457` together with any `AGENTDESK_HYBRID_SCROLL_VIEWPORT_*` environment lookup that feeds them.

- [x] **Step 3: Build and test**

Run: `just check`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add host/AgentDeskHost/Config.swift
git commit -m "refactor: delete unused scroll-viewport config knobs

Five knobs parameterized the retired viewport streak detector and have no
reader. Deleting them before adding cache knobs keeps Config honest.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 4: Unify the three tile-build paths into one `buildTile` seam

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (`makeScrollEnvelope` ~527, `makeTileEnvelope` ~741, `makeJpegTile` ~827, `makeJPEGFrameEnvelope` ~806; stale comments at `ScrollDeltaEngine.swift:12,736` and `Config.swift:310`)
- Test: `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift`

**Interfaces:**
- Produces:
  ```swift
  enum TileEncoding { case lzfse; case jpeg(quality: Double, scale: Double) }
  // Extracts the cell BGRA once, compresses per `encoding`, returns the command
  // plus its payload bytes. `payloadOffset` is the byteRange offset to record.
  private func buildTile(surface: Surface, rect: PixelRect, encoding: TileEncoding, payloadOffset: Int) -> (command: OwnedGraphicsCommand, payload: Data)?
  ```
- Consumes: existing `tileData`, `compressLZFSE`, `downscaleBGRA`, `compressJPEGWithinBudget`.

- [x] **Step 1: Add a focused test that `buildTile` produces a wire-equal LZFSE tile**

Add to `ScrollDeltaEngineDamageRoutingTests.swift` a test that drives the existing `.tiles` damage routing on a small synthetic frame and asserts the emitted commands are `.bitmapTile(compression: .lzfse)` with payload lengths matching their byteRanges (the behavior unchanged by the refactor). Reuse the file's existing frame/damage builders.

- [x] **Step 2: Run it green against current code**

Run: `just check`
Expected: PASS (this pins current behavior before the refactor).

- [x] **Step 3: Introduce `buildTile`**

Add, next to `makeJpegTile`:

```swift
enum TileEncoding {
    case lzfse
    case jpeg(quality: Double, scale: Double)
}

// One tile builder for every path. Extracts the cell BGRA once, compresses per
// the requested encoding, and returns the command plus payload. The lossless
// LZFSE path keeps text crisp; the JPEG path carries the congestion quality and
// downscale for the fullframe fallback and the large exposed scroll strip.
private func buildTile(surface: Surface, rect: PixelRect, encoding: TileEncoding, payloadOffset: Int) -> (command: OwnedGraphicsCommand, payload: Data)? {
    switch encoding {
    case .lzfse:
        guard let bgra = tileData(surface: surface, x: rect.x, y: rect.y, width: rect.width, height: rect.height),
              let compressed = compressLZFSE(bgra) else { return nil }
        let command = OwnedGraphicsCommand.bitmapTile(
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            compression: .lzfse,
            byteRange: OwnedGraphicsByteRange(offset: payloadOffset, length: compressed.count)
        )
        return (command, compressed)
    case let .jpeg(quality, scale):
        guard let tile = makeJpegTile(current: surface, rect: rect, quality: quality, scale: scale) else { return nil }
        // makeJpegTile emits byteRange offset 0; re-stamp the real offset.
        guard case let .bitmapTile(x, y, w, h, comp, range) = tile.command else { return nil }
        let command = OwnedGraphicsCommand.bitmapTile(
            x: x, y: y, width: w, height: h, compression: comp,
            byteRange: OwnedGraphicsByteRange(offset: payloadOffset, length: range.length)
        )
        return (command, tile.payload)
    }
}
```

- [x] **Step 4: Route the three callers through `buildTile`**

In `makeTileEnvelope`, replace the per-cell `tileData`+`compressLZFSE`+`.bitmapTile` block with:

```swift
        guard let built = buildTile(surface: current, rect: cell, encoding: .lzfse, payloadOffset: payload.count) else { return nil }
        commands.append(built.command)
        payload.append(built.payload)
```

In `makeScrollEnvelope`, replace the lossy strip branch and the lossless strip branch with a single `buildTile` call selecting encoding by `useLossy`:

```swift
        let stripRect = PixelRect(x: tileX, y: tileY, width: tileWidth, height: tileHeight)
        let stripRawBytes = tileWidth * tileHeight * 4
        let useLossy = congestionLevel > 0 || stripRawBytes >= Config.hybridScrollStripLossyThresholdBytes
        let encoding: TileEncoding = useLossy
            ? .jpeg(quality: fullframeQuality(forLevel: congestionLevel, motion: motion), scale: fullframeScale(forLevel: congestionLevel))
            : .lzfse
        guard let strip = buildTile(surface: current, rect: stripRect, encoding: encoding, payloadOffset: 0) else { return nil }
        let stripCommand = strip.command
        let payload = strip.payload
```

In `makeJPEGFrameEnvelope`, replace the `makeJpegTile` call with:

```swift
        guard let tile = buildTile(surface: current, rect: region, encoding: .jpeg(quality: quality, scale: scale), payloadOffset: 0) else { return nil }
```

Keep `makeJpegTile` as the JPEG implementation that `buildTile` calls; do not duplicate its vImage/JPEG logic.

- [x] **Step 5: Update the stale comments**

At `ScrollDeltaEngine.swift:12`, `ScrollDeltaEngine.swift:736`, and `Config.swift:310`, replace "for a future content-hash cache" with a present-tense reference, for example: "the fixed grid gives each tile a stable identity for the content tile cache (see the content-tile-cache design and its ADR)".

- [x] **Step 6: Run the suite**

Run: `just check`
Expected: PASS. The routing tests prove behavior is unchanged.

- [x] **Step 7: Commit**

```bash
git add host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHost/Config.swift host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift
git commit -m "refactor: unify tile build into one buildTile seam

The scroll strip, damage tiles, and fullframe paths each did tileData plus
compression independently. Collapse them onto one buildTile(rect, encoding)
so the cache decision intercepts a single per-cell seam. Behavior unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

## Phase 1: Rung 1, retained-baseline tile skip (freeze fix, no wire change)

### Task 5: Omit unchanged cells; all-unchanged tiles frame becomes `.noChange`

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (`makeTileEnvelope` and its `.tiles` caller in `evaluateWithDamage` ~669-685)
- Test: `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift`

**Interfaces:**
- Produces:
  ```swift
  private enum TileBuild { case built(OwnedGraphicsFrameEnvelope); case allUnchanged; case failed }
  private mutating func makeTileEnvelope(current: Surface, previous: Surface, rects: [PixelRect], capturedAtUptimeNs: UInt64) -> TileBuild
  ```
- Consumes: `buildTile` (Task 4), `tileData`, `previous` (already a param of `evaluateWithDamage`).

- [x] **Step 1: Write the failing test, identical consecutive tiles frame yields noChange**

Add to `ScrollDeltaEngineDamageRoutingTests.swift`:

```swift
func testIdenticalTilesFrameSecondTimeIsNoChange() {
    var engine = ScrollDeltaEngine()
    let first = makeBGRAFrame(width: 256, height: 256, fill: 0x20)   // existing helper
    // Seed the surface (reset path) then a real tiles change.
    _ = engine.evaluate(first)                                       // reset
    let changed = makeBGRAFrame(width: 256, height: 256, fill: 0x20, dirtyRect: PixelRect(x: 0, y: 0, width: 64, height: 64), dirtyFill: 0x80)
    let r1 = engine.evaluate(changed)
    XCTAssertEqual(r1.kind, .accepted)
    engine.commitPendingSurface()
    // Re-send the exact same frame: the OS reports the same dirty rect but the
    // pixels equal the retained baseline, so nothing should be sent.
    let r2 = engine.evaluate(changed)
    XCTAssertEqual(r2.kind, .noChange)
}
```
Use the file's existing frame and damage-rect builders; adapt the helper names to what the test file already defines.

- [x] **Step 2: Run it, expect failure**

Run: `just check`
Expected: FAIL, `r2.kind` is `.accepted` (the current code re-sends the unchanged tile).

- [x] **Step 3: Rewrite `makeTileEnvelope` to skip unchanged cells and signal emptiness**

```swift
private enum TileBuild {
    case built(OwnedGraphicsFrameEnvelope)
    case allUnchanged
    case failed
}

private mutating func makeTileEnvelope(current: Surface, previous: Surface, rects: [PixelRect], capturedAtUptimeNs: UInt64) -> TileBuild {
    let cells = TileGrid.cells(covering: rects, surfaceWidth: current.width, surfaceHeight: current.height, gridPx: tileGridPx)
    guard !cells.isEmpty else { return .allUnchanged }
    var commands: [OwnedGraphicsCommand] = []
    var payload = Data()
    for cell in cells {
        guard cell.area > 0,
              let tile = tileData(surface: current, x: cell.x, y: cell.y, width: cell.width, height: cell.height) else { return .failed }
        // Rung 1: the client already shows these exact pixels here (the retained
        // baseline mirrors `previous`), so omit the tile. macOS dirtyRects often
        // report a redraw that produced identical pixels; this absorbs them.
        if let prior = tileData(surface: previous, x: cell.x, y: cell.y, width: cell.width, height: cell.height), prior == tile {
            continue
        }
        guard let built = buildTile(surface: current, rect: cell, encoding: .lzfse, payloadOffset: payload.count) else { return .failed }
        commands.append(built.command)
        payload.append(built.payload)
    }
    guard !commands.isEmpty else { return .allUnchanged }
    graphicsFrameId &+= 1
    return .built(OwnedGraphicsFrameEnvelope(
        header: OwnedGraphicsFrameHeader(
            surfaceGeneration: surfaceGeneration,
            frameId: graphicsFrameId,
            capturedAtUptimeNs: capturedAtUptimeNs,
            commandCount: commands.count,
            payloadLength: payload.count
        ),
        commands: commands,
        payload: payload
    ))
}
```
Note the `graphicsFrameId &+= 1` now lives inside `makeTileEnvelope` and only fires when a frame is actually built.

- [x] **Step 4: Update the `.tiles` caller in `evaluateWithDamage`**

Replace the `.tiles` case body (currently increments `graphicsFrameId`, calls the old `makeTileEnvelope`, returns accepted/rejected) with:

```swift
        case .tiles(let rects):
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            pendingSurface = current
            switch makeTileEnvelope(current: current, previous: previous, rects: rects, capturedAtUptimeNs: frame.capturedAtUptimeNs) {
            case .built(let envelope):
                return ScrollDeltaResult(
                    kind: .accepted,
                    envelope: envelope,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), scrollHint: scrollHint, trace: trace, acceptedBy: "damage-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            case .allUnchanged:
                return ScrollDeltaResult(
                    kind: .noChange,
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), scrollHint: scrollHint, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            case .failed:
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-tile-envelope-build-failed"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), scrollHint: scrollHint, trace: trace, acceptedBy: "damage-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
```
On `.allUnchanged`, `pendingSurface = current` is kept set (current equals previous on the changed-but-unchanged cells and outside the damage), matching the existing `.noChange` semantics.

- [x] **Step 5: Add the partial-change test**

```swift
func testPartialTilesChangeSendsOnlyChangedCells() {
    var engine = ScrollDeltaEngine()
    let base = makeBGRAFrame(width: 256, height: 256, fill: 0x20)
    _ = engine.evaluate(base); engine.commitPendingSurface()
    // Two dirty cells reported, but only one actually differs from baseline.
    let frame = makeBGRAFrame(width: 256, height: 256, fill: 0x20,
        dirtyRects: [PixelRect(x: 0, y: 0, width: 64, height: 64), PixelRect(x: 128, y: 128, width: 64, height: 64)],
        changedRect: PixelRect(x: 0, y: 0, width: 64, height: 64), changedFill: 0x90)
    let r = engine.evaluate(frame)
    XCTAssertEqual(r.kind, .accepted)
    let tiles = r.envelope!.commands.filter { $0.kindIsBitmapTile }
    XCTAssertEqual(tiles.count, 1)   // the unchanged cell at (128,128) is omitted
}
```
Adapt `makeBGRAFrame` argument names to the test file's helpers, adding a multi-dirty-rect variant if one is not present.

- [x] **Step 6: Run the suite**

Run: `just check`
Expected: PASS (both new tests and all existing routing tests).

- [x] **Step 7: Commit**

```bash
git add host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift
git commit -m "fix: omit unchanged tiles against the retained baseline

The thin-link freeze was the host re-encoding and re-sending grid tiles whose
pixels already matched the retained surface, because macOS dirtyRects reported
identical redraws as dirty. Compare each cell to previous and omit equal cells;
an all-unchanged tiles frame becomes noChange, freeing the link.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

**Device-validation gate (request from the user, do not self-launch):** after this task, the freeze regression is the test to run on the phone. The identical-frame burst should collapse to one frame then silence in the host log, no multi-second freeze on sustained fast flicks.

---

## Phase 2: Rungs 2-3, content-addressed cache

### Task 6: Cache config knobs

**Files:**
- Modify: `host/AgentDeskHost/Config.swift`

**Interfaces:**
- Produces: `Config.hybridTileCacheSlots: Int` (default 512), `Config.hybridTileCacheEnabled: Bool` (default true).

- [x] **Step 1: Add the two knobs following the existing `hybrid*` pattern**

```swift
    // Content tile cache: number of host/client-mirrored slots. Memory is
    // slots * maxCellBytes on each side; at 512 * 64*64*4 that is ~8 MB.
    static let hybridTileCacheSlots: Int = envInt("AGENTDESK_HYBRID_TILE_CACHE_SLOTS", default: 512)
    // Kill switch; false falls back to rung-1 baseline skip only.
    static let hybridTileCacheEnabled: Bool = envBool("AGENTDESK_HYBRID_TILE_CACHE_ENABLED", default: true)
```
Use whatever `envInt`/`envBool` helpers `Config.swift` already uses; match the surrounding style exactly.

- [x] **Step 2: Build**

Run: `just check`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add host/AgentDeskHost/Config.swift
git commit -m "feat: add content tile cache config knobs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 7: `TileContentCache` host unit

**Files:**
- Create: `host/AgentDeskHost/TileContentCache.swift`
- Create: `host/AgentDeskHostTests/TileContentCacheTests.swift`
- Modify: `host/AgentDeskHost.xcodeproj/project.pbxproj` (add both files to the target and test target)

**Interfaces:**
- Produces:
  ```swift
  struct TileContentCache {
      init(slotCount: Int)
      static func hash(_ bytes: Data) -> UInt64
      func lookup(hash: UInt64, bytes: Data) -> UInt16?     // slot only if committed bytes match
      mutating func assign(hash: UInt64, bytes: Data) -> UInt16  // stage a slot for new content
      mutating func commitPending()
      mutating func discardPending()
      mutating func reset()
  }
  ```

- [x] **Step 1: Write the failing tests**

Create `host/AgentDeskHostTests/TileContentCacheTests.swift`:

```swift
import XCTest
@testable import AgentDeskHost

final class TileContentCacheTests: XCTestCase {
    private func bytes(_ b: UInt8, count: Int = 16) -> Data { Data(repeating: b, count: count) }

    func testLookupMissThenHitAfterCommit() {
        var cache = TileContentCache(slotCount: 4)
        let a = bytes(0x10)
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
        let slot = cache.assign(hash: TileContentCache.hash(a), bytes: a)
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a)) // not visible until commit
        cache.commitPending()
        XCTAssertEqual(cache.lookup(hash: TileContentCache.hash(a), bytes: a), slot)
    }

    func testDiscardPendingDropsUncommitted() {
        var cache = TileContentCache(slotCount: 4)
        let a = bytes(0x11)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a)
        cache.discardPending()
        cache.commitPending()
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
    }

    func testHashCollisionIsVerifiedByBytes() {
        var cache = TileContentCache(slotCount: 4)
        let a = bytes(0x12)
        let b = bytes(0x34)
        let slot = cache.assign(hash: TileContentCache.hash(a), bytes: a)
        cache.commitPending()
        // Force a's hash with b's bytes: lookup must reject (bytes differ).
        XCTAssertEqual(cache.lookup(hash: TileContentCache.hash(a), bytes: a), slot)
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: b))
    }

    func testLRUEvictsOldestAfterSlotCountDistinctTiles() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x01), b = bytes(0x02), c = bytes(0x03)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        _ = cache.assign(hash: TileContentCache.hash(b), bytes: b); cache.commitPending()
        _ = cache.assign(hash: TileContentCache.hash(c), bytes: c); cache.commitPending() // evicts a
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(b), bytes: b))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(c), bytes: c))
    }

    func testResetClearsEverything() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x05)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        cache.reset()
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
    }
}
```

- [x] **Step 2: Run, expect failure (type does not exist)**

Run: `just check`
Expected: FAIL to compile, `cannot find 'TileContentCache' in scope`.

- [x] **Step 3: Implement `TileContentCache`**

Create `host/AgentDeskHost/TileContentCache.swift`:

```swift
import Foundation

// Host model of the content the client holds in its slot cache, the RDP bitmap
// cache analog. Keyed by a 64-bit content hash; every hit is verified by a byte
// compare so a hash collision can never reference the wrong pixels. The host
// owns slot assignment (LRU); reassigning a slot overwrites it on both sides, so
// eviction needs no separate message. Updates are staged and applied only on
// commit, riding the engine's send-success surface commit.
struct TileContentCache {
    private let slotCount: Int
    private var byHash: [UInt64: UInt16] = [:]
    private var slotBytes: [UInt16: Data] = [:]
    private var slotHash: [UInt16: UInt64] = [:]
    private var order: [UInt16] = []   // committed slots, front = least recently used
    private struct Pending { let slot: UInt16; let hash: UInt64; let bytes: Data }
    private var pending: [Pending] = []

    init(slotCount: Int) { self.slotCount = max(1, slotCount) }

    static func hash(_ bytes: Data) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        bytes.withUnsafeBytes { raw in
            for byte in raw { h = (h ^ UInt64(byte)) &* 0x00000100000001B3 }
        }
        return h
    }

    func lookup(hash: UInt64, bytes: Data) -> UInt16? {
        guard let slot = byHash[hash], slotBytes[slot] == bytes else { return nil }
        return slot
    }

    mutating func assign(hash: UInt64, bytes: Data) -> UInt16 {
        let slot = chooseSlot()
        pending.append(Pending(slot: slot, hash: hash, bytes: bytes))
        return slot
    }

    mutating func commitPending() {
        for entry in pending {
            if let oldHash = slotHash[entry.slot] { byHash[oldHash] = nil }
            byHash[entry.hash] = entry.slot
            slotBytes[entry.slot] = entry.bytes
            slotHash[entry.slot] = entry.hash
            order.removeAll { $0 == entry.slot }
            order.append(entry.slot)
        }
        pending.removeAll()
    }

    mutating func discardPending() { pending.removeAll() }

    mutating func reset() {
        byHash.removeAll(); slotBytes.removeAll(); slotHash.removeAll()
        order.removeAll(); pending.removeAll()
    }

    // Pick a slot not already used this frame: a free integer if the cache is not
    // full, else the least-recently-used committed slot that is not staged.
    private func chooseSlot() -> UInt16 {
        let staged = Set(pending.map { $0.slot })
        if slotBytes.count + pending.count < slotCount {
            var candidate: UInt16 = 0
            while candidate < UInt16(slotCount) {
                if slotBytes[candidate] == nil && !staged.contains(candidate) { return candidate }
                candidate += 1
            }
        }
        for slot in order where !staged.contains(slot) { return slot }
        return 0
    }
}
```

- [x] **Step 4: Add both files to the Xcode targets**

In `host/AgentDeskHost.xcodeproj/project.pbxproj`, add `TileContentCache.swift` to the `AgentDeskHost` Sources build phase and group, and `TileContentCacheTests.swift` to the test target, following the pattern of an existing pair of source+test files.

- [x] **Step 5: Run, expect pass**

Run: `just check`
Expected: PASS (all five tests).

- [x] **Step 6: Commit**

```bash
git add host/AgentDeskHost/TileContentCache.swift host/AgentDeskHostTests/TileContentCacheTests.swift host/AgentDeskHost.xcodeproj/project.pbxproj
git commit -m "feat: TileContentCache, the host model of client-held tile content

Hash-keyed, byte-verified, LRU, staged-then-committed slot store. The RDP
bitmap-cache analog adapted to our send-success commit lifecycle.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 8: Wire, add `cacheTile` and `drawCachedTile`

**Files:**
- Modify: `host/AgentDeskHost/SharedTypes.swift` and `client/AgentDeskClient/SharedTypes.swift` (identical edits to `OwnedGraphicsCommand`)
- Test: `host/AgentDeskHostTests/` (a codec round-trip test; add to an existing wire/codec test file, for example `SignalingFrameRoutingTests.swift` or create `OwnedGraphicsCommandCodecTests.swift`)

**Interfaces:**
- Produces two new cases on `OwnedGraphicsCommand`:
  ```swift
  case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
  case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)
  ```

- [x] **Step 1: Write the failing codec round-trip test**

Create `host/AgentDeskHostTests/OwnedGraphicsCommandCodecTests.swift`:

```swift
import XCTest
@testable import AgentDeskHost

final class OwnedGraphicsCommandCodecTests: XCTestCase {
    private func roundTrip(_ command: OwnedGraphicsCommand) throws -> OwnedGraphicsCommand {
        let data = try JSONEncoder().encode(command)
        return try JSONDecoder().decode(OwnedGraphicsCommand.self, from: data)
    }

    func testCacheTileRoundTrips() throws {
        let c = OwnedGraphicsCommand.cacheTile(slot: 7, x: 64, y: 128, width: 64, height: 64, compression: .lzfse, byteRange: OwnedGraphicsByteRange(offset: 0, length: 42))
        XCTAssertEqual(try roundTrip(c), c)
        try c.validateForCurrentScope(payloadLength: 42)
    }

    func testDrawCachedTileRoundTrips() throws {
        let c = OwnedGraphicsCommand.drawCachedTile(slot: 7, x: 64, y: 128, width: 64, height: 64)
        XCTAssertEqual(try roundTrip(c), c)
        try c.validateForCurrentScope()
    }
}
```
Add the new file to the host test target in the pbxproj.

- [x] **Step 2: Run, expect failure**

Run: `just check`
Expected: FAIL to compile, the new cases do not exist.

- [x] **Step 3: Add the cases to BOTH `SharedTypes.swift` copies**

In each file, in `enum OwnedGraphicsCommand`:

```swift
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)
```

In `enum Kind`: add `case cacheTile` and `case drawCachedTile`.

In `enum CodingKeys`: add `case slot = "sl"`.

In `validateForCurrentScope`:

```swift
        case let .cacheTile(_, x, y, width, height, _, byteRange):
            guard x >= 0, y >= 0, width > 0, height > 0,
                  byteRange.offset >= 0, byteRange.length > 0,
                  byteRange.offset <= payloadLength,
                  byteRange.length <= payloadLength - byteRange.offset
            else { throw SessionRejected(reason: .malformed) }
        case let .drawCachedTile(_, x, y, width, height):
            guard x >= 0, y >= 0, width > 0, height > 0 else { throw SessionRejected(reason: .malformed) }
```

In `init(from:)`:

```swift
        case .cacheTile:
            self = .cacheTile(
                slot: try container.decode(UInt16.self, forKey: .slot),
                x: try container.decode(Int.self, forKey: .x),
                y: try container.decode(Int.self, forKey: .y),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height),
                compression: try container.decode(OwnedGraphicsTileCompression.self, forKey: .compression),
                byteRange: try container.decode(OwnedGraphicsByteRange.self, forKey: .byteRange)
            )
        case .drawCachedTile:
            self = .drawCachedTile(
                slot: try container.decode(UInt16.self, forKey: .slot),
                x: try container.decode(Int.self, forKey: .x),
                y: try container.decode(Int.self, forKey: .y),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height)
            )
```

In `encode(to:)`:

```swift
        case let .cacheTile(slot, x, y, width, height, compression, byteRange):
            try container.encode(Kind.cacheTile, forKey: .kind)
            try container.encode(slot, forKey: .slot)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
            try container.encode(compression, forKey: .compression)
            try container.encode(byteRange, forKey: .byteRange)
        case let .drawCachedTile(slot, x, y, width, height):
            try container.encode(Kind.drawCachedTile, forKey: .kind)
            try container.encode(slot, forKey: .slot)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
```

- [x] **Step 4: Run, expect host codec tests pass**

Run: `just check`
Expected: PASS. Both copies compile (the client copy is now exhaustive too; its `OwnedMediaVideoSink` switch is handled in Task 9, so a non-exhaustive switch there will fail to compile until Task 9. If Task 9 is not yet done, the client target will not build, so Task 8 and Task 9 may be committed together; see Step 6.)

- [x] **Step 5: Keep the two copies byte-identical in the command region**

```bash
diff <(sed -n '/enum OwnedGraphicsCommand/,/^}/p' host/AgentDeskHost/SharedTypes.swift) <(sed -n '/enum OwnedGraphicsCommand/,/^}/p' client/AgentDeskClient/SharedTypes.swift)
```
Expected: empty diff for the enum body and its `Codable` extension. If they differ, reconcile.

- [x] **Step 6: Commit (jointly with Task 9 if the client will not build alone)**

Because the client `OwnedMediaVideoSink` switch over `OwnedGraphicsCommand` becomes non-exhaustive the moment the cases are added, build the client handlers (Task 9) before running the full `just check`, then commit Tasks 8 and 9 together:

```bash
git add host/AgentDeskHost/SharedTypes.swift client/AgentDeskClient/SharedTypes.swift host/AgentDeskHostTests/OwnedGraphicsCommandCodecTests.swift host/AgentDeskHost.xcodeproj/project.pbxproj
# plus the Task 9 client files
git commit -m "feat: cacheTile and drawCachedTile wire commands

The RDP CACHE_BITMAP and MEMBLT analogs: cacheTile paints and stores a tile
under a slot, drawCachedTile blits a stored slot. Added identically to both
SharedTypes copies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 9: Client slot store and handlers

**Files:**
- Modify: `client/AgentDeskClient/OwnedMediaVideoSink.swift` (`OwnedSurfaceValidatedCommand`, `validateGraphicsFrame`, the apply loop, `resetSurface`, add `slotBitmaps`)
- Test: `client/AgentDeskClientTests/` (compositor test file, e.g. an existing owned-surface test or new `OwnedSurfaceCompositorCacheTests.swift`)

**Interfaces:**
- Consumes: `OwnedGraphicsCommand.cacheTile`, `OwnedGraphicsCommand.drawCachedTile` (Task 8).
- Produces: a compositor that stores cached tiles by slot and blits them, clearing slots on reset.

- [x] **Step 1: Write failing compositor tests**

Create `client/AgentDeskClientTests/OwnedSurfaceCompositorCacheTests.swift`:

```swift
import XCTest
@testable import AgentDeskClient

final class OwnedSurfaceCompositorCacheTests: XCTestCase {
    // Build helpers mirror the existing compositor tests; reuse them if present.

    func testCacheTileStoresThenDrawCachedTileBlits() throws {
        var compositor = OwnedSurfaceCompositor()
        // reset to a 128x128 surface, then cacheTile a 64x64 solid tile at (0,0),
        // then drawCachedTile that slot to (64,64). Assert the destination pixels
        // equal the cached tile and the source region is unchanged.
        // (Use the test file's envelope builders; assert via pixelBytesForDiagnostics().)
    }

    func testDrawCachedTileForMissingSlotIsRejected() throws {
        var compositor = OwnedSurfaceCompositor()
        // reset, then drawCachedTile slot 9 (never cached) -> applyGraphicsFrame
        // returns a stale/!graphics action or throws; assert it does not paint.
    }

    func testResetClearsSlots() throws {
        // cacheTile a slot, reset the surface, then a drawCachedTile of that slot
        // must be rejected (slot cleared).
    }
}
```
Fill the bodies using the envelope/byte helpers the existing client compositor tests already provide. Add the file to the client test target in the pbxproj.

- [x] **Step 2: Run, expect failure**

Run: `just check`
Expected: FAIL (compile or assertion): the compositor has no slot store or handlers.

- [x] **Step 3: Add the slot store and validated-command cases**

In `OwnedSurfaceCompositor`, add:

```swift
    private var slotBitmaps: [UInt16: (width: Int, height: Int, pixels: Data)] = [:]
```

Extend `OwnedSurfaceValidatedCommand`:

```swift
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, decoded: Data)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)
```

- [x] **Step 4: Validate the new commands in `validateGraphicsFrame`**

Add arms alongside `.bitmapTile`:

```swift
            case let .cacheTile(slot, x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId),
                      compression == .lzfse || compression == .jpeg else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(x: x, y: y, width: width, height: height, surfaceWidth: candidateWidth, surfaceHeight: candidateHeight, bytesPerRow: candidateBytesPerRow, pixelCount: candidatePixelCount)
                let end = byteRange.offset + byteRange.length
                guard byteRange.offset >= 0, byteRange.length > 0, end <= envelope.payload.count else {
                    throw SessionRejected(reason: .malformed)
                }
                let compressed = Data(envelope.payload[byteRange.offset..<end])
                let decoded: Data
                switch compression {
                case .lzfse: decoded = try decompressLZFSE(compressed, expectedCount: width * height * 4)
                case .jpeg: decoded = try Self.decodeJPEG(compressed, width: width, height: height)
                }
                validated.append(.cacheTile(slot: slot, x: x, y: y, width: width, height: height, decoded: decoded))
            case let .drawCachedTile(slot, x, y, width, height):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId) else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(x: x, y: y, width: width, height: height, surfaceWidth: candidateWidth, surfaceHeight: candidateHeight, bytesPerRow: candidateBytesPerRow, pixelCount: candidatePixelCount)
                validated.append(.drawCachedTile(slot: slot, x: x, y: y, width: width, height: height))
```

The existing `.bitmapTile` and the `default`/exhaustive switch must still compile; remove any now-dead `default` if the switch is meant to be exhaustive.

- [x] **Step 5: Apply the new commands in the apply loop**

Add to the `for command in validatedCommands` switch:

```swift
            case let .cacheTile(slot, x, y, width, height, decoded):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(decoded, x: x, y: y, width: width, height: height)
                slotBitmaps[slot] = (width, height, decoded)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(from: paintStartNs, to: DispatchTime.now().uptimeNanoseconds)
                tileBytes += decoded.count
            case let .drawCachedTile(slot, x, y, width, height):
                guard let cached = slotBitmaps[slot], cached.width == width, cached.height == height else {
                    throw SessionRejected(reason: .malformed)   // missing or mismatched slot -> reset path
                }
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(cached.pixels, x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(from: paintStartNs, to: DispatchTime.now().uptimeNanoseconds)
                copyRects += 0
```

- [x] **Step 6: Clear slots on reset**

In the `.resetSurface` apply arm, after `pixels = Data(count: bytesPerRow * height)`, add:

```swift
                slotBitmaps.removeAll()
```

- [x] **Step 7: Run, expect pass**

Run: `just check`
Expected: PASS (client compositor cache tests plus the Task 8 host codec tests).

- [x] **Step 8: Commit**

Commit jointly with Task 8 (see Task 8 Step 6), adding the client files:

```bash
git add client/AgentDeskClient/OwnedMediaVideoSink.swift client/AgentDeskClientTests/OwnedSurfaceCompositorCacheTests.swift client/AgentDeskClient.xcodeproj/project.pbxproj
```

---

### Task 10: Wire the cache into the engine decision ladder

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (`makeTileEnvelope` loop, `commitPendingSurface`, `invalidateRetainedSurface`, the reset branch in `evaluate`, the resize generation-bump branch, the top of `evaluateWithDamage`; add a `tileCache` property)
- Test: `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift`

**Interfaces:**
- Consumes: `TileContentCache` (Task 7), `cacheTile`/`drawCachedTile` (Task 8), `Config.hybridTileCacheSlots`/`hybridTileCacheEnabled` (Task 6).

- [x] **Step 1: Write the failing tests**

Add to `ScrollDeltaEngineDamageRoutingTests.swift`:

```swift
func testRepeatedContentAtNewPositionUsesDrawCachedTile() {
    var engine = ScrollDeltaEngine()
    let base = makeBGRAFrame(width: 256, height: 256, fill: 0x20)
    _ = engine.evaluate(base); engine.commitPendingSurface()
    // A distinctive 64x64 tile appears at (0,0): cacheTile (sends pixels).
    let f1 = makeBGRAFrame(width: 256, height: 256, fill: 0x20, dirtyRect: PixelRect(x: 0, y: 0, width: 64, height: 64), dirtyFill: 0xAA)
    let r1 = engine.evaluate(f1); engine.commitPendingSurface()
    XCTAssertTrue(r1.envelope!.commands.contains { if case .cacheTile = $0 { return true }; return false })
    // The same content now appears at (128,128) while (0,0) reverts to base.
    let f2 = makeBGRAFrame(width: 256, height: 256, fill: 0x20, dirtyRects: [PixelRect(x: 0, y: 0, width: 64, height: 64), PixelRect(x: 128, y: 128, width: 64, height: 64)], paint: [(PixelRect(x: 0, y: 0, width: 64, height: 64), 0x20), (PixelRect(x: 128, y: 128, width: 64, height: 64), 0xAA)])
    let r2 = engine.evaluate(f2); engine.commitPendingSurface()
    XCTAssertTrue(r2.envelope!.commands.contains { if case .drawCachedTile = $0 { return true }; return false })
}

func testGenerationResetClearsCache() {
    var engine = ScrollDeltaEngine()
    let base = makeBGRAFrame(width: 256, height: 256, fill: 0x20)
    _ = engine.evaluate(base); engine.commitPendingSurface()
    let f1 = makeBGRAFrame(width: 256, height: 256, fill: 0x20, dirtyRect: PixelRect(x: 0, y: 0, width: 64, height: 64), dirtyFill: 0xAA)
    _ = engine.evaluate(f1); engine.commitPendingSurface()
    engine.invalidateRetainedSurface()
    // After reset, the same content must be re-sent as cacheTile, never drawCachedTile.
    let reseed = makeBGRAFrame(width: 256, height: 256, fill: 0x20)
    _ = engine.evaluate(reseed); engine.commitPendingSurface()   // reset path
    let f2 = makeBGRAFrame(width: 256, height: 256, fill: 0x20, dirtyRect: PixelRect(x: 128, y: 128, width: 64, height: 64), dirtyFill: 0xAA)
    let r = engine.evaluate(f2)
    XCTAssertFalse(r.envelope!.commands.contains { if case .drawCachedTile = $0 { return true }; return false })
}
```
Adapt `makeBGRAFrame` painting helpers to the test file's actual API; add a multi-region paint variant if needed.

- [x] **Step 2: Run, expect failure**

Run: `just check`
Expected: FAIL: no `cacheTile`/`drawCachedTile` is emitted (the engine still only emits `.bitmapTile`).

- [x] **Step 3: Add the cache property and reset hooks**

In `ScrollDeltaEngine`, add:

```swift
    private var tileCache = TileContentCache(slotCount: Config.hybridTileCacheSlots)
```

In `commitPendingSurface()`, after `previous = pendingSurface`:

```swift
        tileCache.commitPending()
```

In `invalidateRetainedSurface()`, add:

```swift
        tileCache.reset()
```

In the reset branch of `evaluate` (the `guard let previous else { ... }` block that bumps `surfaceGeneration &+= 1` and sends the reset stripe), add `tileCache.reset()` right after `surfaceGeneration &+= 1`. Do the same in the resize branch that bumps `surfaceGeneration` on a size change. The client zeros its surface and clears `slotBitmaps` on `resetSurface`, so both sides clear together.

At the very top of `evaluateWithDamage` (before the `makeSurface` guard), add:

```swift
        tileCache.discardPending()
```
This guarantees staged slot updates live only within one evaluate-then-commit cycle; a held, failed, or non-tiles frame never commits a prior tiles frame's staging.

- [x] **Step 4: Replace the per-cell loop body in `makeTileEnvelope` with the decision ladder**

```swift
    for cell in cells {
        guard cell.area > 0,
              let tile = tileData(surface: current, x: cell.x, y: cell.y, width: cell.width, height: cell.height) else { return .failed }
        // Rung 1: client already shows these exact pixels here.
        if let prior = tileData(surface: previous, x: cell.x, y: cell.y, width: cell.width, height: cell.height), prior == tile {
            continue
        }
        if Config.hybridTileCacheEnabled {
            let h = TileContentCache.hash(tile)
            // Rung 2: client already holds this content in a slot.
            if let slot = tileCache.lookup(hash: h, bytes: tile) {
                commands.append(.drawCachedTile(slot: slot, x: cell.x, y: cell.y, width: cell.width, height: cell.height))
                continue
            }
            // Rung 3: send the pixels and record the slot (staged until commit).
            guard let compressed = compressLZFSE(tile) else { return .failed }
            let slot = tileCache.assign(hash: h, bytes: tile)
            commands.append(.cacheTile(
                slot: slot, x: cell.x, y: cell.y, width: cell.width, height: cell.height,
                compression: .lzfse, byteRange: OwnedGraphicsByteRange(offset: payload.count, length: compressed.count)
            ))
            payload.append(compressed)
        } else {
            guard let built = buildTile(surface: current, rect: cell, encoding: .lzfse, payloadOffset: payload.count) else { return .failed }
            commands.append(built.command)
            payload.append(built.payload)
        }
    }
```
`makeTileEnvelope` is already `mutating` (Task 5), so staging into `tileCache` is allowed.

- [x] **Step 5: Run, expect pass**

Run: `just check`
Expected: PASS, including the Task 5 freeze and partial-change tests (rung 1 still fires first) and the new rung 2/3 tests.

- [x] **Step 6: Commit**

```bash
git add host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift
git commit -m "feat: drive tiles through the content cache decision ladder

Per dirty cell: omit if the retained baseline matches (rung 1), drawCachedTile
if the content is in a slot (rung 2), else cacheTile and stage the slot (rung 3).
Slot commits ride commitPendingSurface; pending is discarded at each evaluate so
held or failed frames never desync the client cache. Reset clears both sides.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

**Device-validation gate (user-driven):** scrolling code/CLI text should show `drawCachedTile` references in the host log on re-exposed and repeated content, text stays crisp (tiles stay LZFSE), and fullframe frequency drops.

---

## Future arc (not in this plan)

RDP glyph/text-region caching for sub-tile crispness. The extension point is the per-cell ladder in `makeTileEnvelope`: a glyph index would sit ahead of rung 3, decomposing a text cell into cached glyph blits. Out of scope here; recorded so the tile-cache structure does not foreclose it.

## Self-review notes

- Spec coverage: Phase 0 (prefactor) -> Tasks 1-4; rung 1 -> Task 5; config -> Task 6; `TileContentCache` -> Task 7; wire -> Task 8; client store -> Task 9; engine ladder + commit lifecycle + invalidation -> Task 10; crisp-text lossless rule -> enforced in Task 10 rung 3 (`.lzfse`) and the global constraints; glyph future arc -> documented above.
- Type consistency: `TileContentCache.lookup/assign/commitPending/discardPending/reset`, `TileEncoding`, `TileBuild`, and the two wire cases use the same signatures everywhere they appear across tasks.
- Commit lifecycle: pending staged in `assign` (Task 10 Step 4), applied in `commitPendingSurface` (Step 3), discarded at each `evaluateWithDamage` entry (Step 3). No pump change required because `commitPendingSurface` is the existing send-success gate and held frames never reach `evaluate`.
