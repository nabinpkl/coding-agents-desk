# Thin-link congestion tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut bytes on a thin link via a smoothed congestion ramp (no quality cliff) and lossy JPEG exposed scroll strips, without crossing the working-version-11 quality floor.

**Architecture:** Replace the binary `congested: Bool` threaded into `ScrollDeltaEngine.evaluate` with a smoothed congestion level in `[0,1]` (EWMA of `heldSinceLastProduce` in the encode pump). The engine maps the level through two pure monotonic curves (quality, scale) used by both the fullframe JPEG path and a newly-lossy exposed scroll strip. The scroll strip becomes JPEG (reusing the fullframe JPEG tile builder) when it is large or the link is congested, else stays LZFSE.

**Tech Stack:** Swift, CoreImage/ImageIO/Accelerate (existing), Swift Testing (`@Test`), xcodebuild via `just check`.

## Global Constraints

- No em-dashes in prose or comments. Use commas, periods, or "and".
- No hardcoded configs: new tunables go through `Config` with an `AGENTDESK_*` env override and a default.
- Quality floor is fixed: congestion scale never below `0.5`, congested JPEG quality never below `0.15` (the working-version-11 floor). The ramp only changes the approach, never crosses it.
- Both levers are host-only. The client is unchanged (it already decodes any-size `.jpeg` tiles).
- `just check` must be green before each commit. Commit + push each green task.
- Co-author trailer on commits: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Congestion level + monotonic quality/scale ramp (replaces the binary cliff)

**Files:**
- Modify: `host/AgentDeskHost/Config.swift` (add 3 tunables near `hybridFullframeCongestedScale`)
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (`evaluate` 306-309, `evaluate` internal call 391, `evaluateWithDamage` 593-597, fullframe quality/scale block ~684-693; add two pure mapping methods)
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift` (pump: EWMA state + call ~925, 989-991)
- Modify (test call sites): `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift` (every `congested:` arg -> `congestionLevel:`)
- Test: `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift` (new ramp tests)

**Interfaces:**
- Produces: `ScrollDeltaEngine.evaluate(_:scrollHint:congestionLevel:)` (was `congested: Bool`), `congestionLevel: Double = 0`. Internal methods `fullframeQuality(forLevel:motion:) -> Double` and `fullframeScale(forLevel:) -> Double`. `Config.hybridCongestionSaturationHolds: Int`, `Config.hybridCongestionEwmaAlpha: Double`, `Config.hybridCongestionScaleRampThreshold: Double`.
- Consumes (Task 2): `congestionLevel` in `evaluateWithDamage`, and `fullframeQuality`/`fullframeScale`.

- [ ] **Step 1: Add Config tunables.** In `Config.swift`, immediately after the `hybridFullframeCongestedScale` block:

```swift
// Number of pump holds-since-last-produce that maps the instantaneous congestion
// signal to 1.0 (fully saturated). Device runs saturated at ~14 holds/frame, so a
// value below that saturates the ramp a bit before the extreme.
static let hybridCongestionSaturationHolds = positiveInt(
    environmentKey: "AGENTDESK_HYBRID_CONGESTION_SATURATION_HOLDS",
    defaultValue: 8
)
// EWMA smoothing for the congestion level so a single held frame does not jump the
// level to maximum (the binary cliff that the macroblock regression came from).
// new = alpha * instantaneous + (1 - alpha) * previous.
static let hybridCongestionEwmaAlpha = positiveDouble(
    environmentKey: "AGENTDESK_HYBRID_CONGESTION_EWMA_ALPHA",
    defaultValue: 0.5
)
// Congestion level below which fullframe resolution stays full (scale 1.0). Above
// it, scale ramps toward the congested floor. Resolution is the heavy hammer,
// reserved for sustained congestion; quality does the gentle early work.
static let hybridCongestionScaleRampThreshold = positiveDouble(
    environmentKey: "AGENTDESK_HYBRID_CONGESTION_SCALE_RAMP_THRESHOLD",
    defaultValue: 0.5
)
```

- [ ] **Step 2: Write the failing ramp tests.** In `ScrollDeltaEngineDamageRoutingTests.swift`, add:

```swift
@Test func congestionQualityRampIsMonotonicBaselineToFloor() {
    let engine = ScrollDeltaEngine()
    let rest = engine.fullframeQuality(forLevel: 0, motion: false)
    let mid = engine.fullframeQuality(forLevel: 0.5, motion: false)
    let full = engine.fullframeQuality(forLevel: 1, motion: false)
    #expect(rest > mid)
    #expect(mid > full)
    #expect(abs(full - 0.15) < 1e-9)            // exactly the congested floor
    #expect(abs(rest - 0.65) < 1e-9)            // exactly the rest baseline
}

@Test func congestionScaleStaysFullUntilThresholdThenRampsToFloor() {
    let engine = ScrollDeltaEngine()
    #expect(engine.fullframeScale(forLevel: 0) == 1.0)
    #expect(engine.fullframeScale(forLevel: 0.5) == 1.0)   // at threshold, still full
    let mid = engine.fullframeScale(forLevel: 0.75)
    #expect(mid < 1.0 && mid > 0.5)                         // ramping
    #expect(abs(engine.fullframeScale(forLevel: 1) - 0.5) < 1e-9)  // floor, never below
}
```

- [ ] **Step 3: Run to verify they fail.** `xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -derivedDataPath .build/DerivedData build test 2>&1 | grep -E 'error:|fullframeQuality'`. Expected: compile error (methods do not exist yet).

- [ ] **Step 4: Add the two pure mapping methods** in `ScrollDeltaEngine.swift` (place just above `makeJPEGFrameEnvelope`):

```swift
// Monotonic quality: the rest or motion baseline at level 0, lerped down to the
// congested floor at level 1. A light backlog costs a little sharpness, not all.
func fullframeQuality(forLevel level: Double, motion: Bool) -> Double {
    let l = min(1, max(0, level))
    let baseline = motion ? fullframeJpegQualityMotion : fullframeJpegQualityRest
    return baseline + (fullframeJpegQualityCongested - baseline) * l
}

// Monotonic scale: full resolution until the ramp threshold, then lerp toward the
// congested floor at level 1. Never below the floor.
func fullframeScale(forLevel level: Double) -> Double {
    let l = min(1, max(0, level))
    let threshold = min(0.999, max(0, Config.hybridCongestionScaleRampThreshold))
    guard l > threshold else { return 1.0 }
    let t = (l - threshold) / (1 - threshold)
    return 1.0 + (fullframeCongestedScale - 1.0) * t
}
```

- [ ] **Step 5: Swap the engine signatures and fullframe block to the level.**
  - `evaluate` signature (306-309): replace `congested: Bool = false` with `congestionLevel: Double = 0`.
  - internal call (391): `congested: congested` -> `congestionLevel: congestionLevel`.
  - `evaluateWithDamage` signature (597): `congested: Bool` -> `congestionLevel: Double`.
  - Fullframe block (684-693): replace the `let quality` if/else and `let scale = congested ? ...` with:

```swift
            let quality = fullframeQuality(forLevel: congestionLevel, motion: scrollHint != nil)
            let scale = fullframeScale(forLevel: congestionLevel)
```

- [ ] **Step 6: Compute the level in the pump.** In `OwnedMediaTransport.swift`, next to `var heldSinceLastProduce = 0` (~925) add `var congestionLevelEwma = 0.0`. Replace lines 989-991 (`let congested = ...; heldSinceLastProduce = 0; let graphics = scrollDeltaEngine.evaluate(frame, scrollHint: scrollHint, congested: congested)`) with:

```swift
            let instantaneousCongestion = min(1.0, Double(heldSinceLastProduce) / Double(Config.hybridCongestionSaturationHolds))
            congestionLevelEwma = Config.hybridCongestionEwmaAlpha * instantaneousCongestion
                + (1 - Config.hybridCongestionEwmaAlpha) * congestionLevelEwma
            heldSinceLastProduce = 0
            let graphics = scrollDeltaEngine.evaluate(frame, scrollHint: scrollHint, congestionLevel: congestionLevelEwma)
```

- [ ] **Step 7: Update existing test call sites.** In `ScrollDeltaEngineDamageRoutingTests.swift`, replace every `congested: true` with `congestionLevel: 1.0` and every `congested: false` with `congestionLevel: 0.0` in `evaluate(...)` calls (the downscale tests and `fullFrameUsesCongestedQualityWhenPumpBackedUp`). The downscale assertion `congested.encoded <= 130` still holds: level 1.0 -> `fullframeScale(1.0) == 0.5`, so 256*0.5 = 128.

- [ ] **Step 8: Run host build+test, expect green.** `xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -derivedDataPath .build/DerivedData build test 2>&1 | grep -E 'error:|TEST (SUCCEEDED|FAILED)|Test run with'`. Expected: `TEST SUCCEEDED`, new tests pass.

- [ ] **Step 9: `just check` then commit + push.**

```bash
just check
git add host/AgentDeskHost/Config.swift host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHost/OwnedMediaTransport.swift host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift
git commit -m "feat: smoothed congestion level + monotonic quality/scale ramp"
git push origin HEAD
```

---

### Task 2: Lossy exposed scroll strips

**Files:**
- Modify: `host/AgentDeskHost/Config.swift` (add `hybridScrollStripLossyThresholdBytes`)
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (extract `makeJpegTile`; `makeScrollEnvelope` 527-586 gains `congestionLevel`/`motion` and a lossy branch; `.scroll` call site ~628-633)
- Test: `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift`

**Interfaces:**
- Consumes: `makeJpegTile(current:rect:quality:scale:)`, `fullframeQuality`/`fullframeScale` (Task 1), `congestionLevel` in the `.scroll` branch.
- Produces: `makeScrollEnvelope(current:offset:region:congestionLevel:motion:capturedAtUptimeNs:)`, `Config.hybridScrollStripLossyThresholdBytes: Int`.

- [ ] **Step 1: Add Config tunable.** In `Config.swift` after the congestion tunables:

```swift
// Raw byte size (width*height*4) above which an exposed scroll strip is sent as
// lossy JPEG instead of lossless LZFSE. A fast flick reveals a tall band that is a
// large lossless blob (device run: ~133KB LZFSE strips); a slow scroll reveals a
// thin strip that stays crisp and is small anyway. Congestion also forces lossy.
static let hybridScrollStripLossyThresholdBytes = positiveInt(
    environmentKey: "AGENTDESK_HYBRID_SCROLL_STRIP_LOSSY_THRESHOLD_BYTES",
    defaultValue: 524_288
)
```

- [ ] **Step 2: Write failing tests.** Add to `ScrollDeltaEngineDamageRoutingTests.swift`. These drive a real downward scroll through `evaluate` so the classifier returns `.scroll` and `makeScrollEnvelope` runs. Helper builds a previous surface, commits it, then a current surface shifted down by `dy`, with a `.scroll` hint.

```swift
// Build BGRA where luma is a per-row hash, so a vertical shift is detectable and a
// scroll classifies cleanly. Mirrors the classifier test surfaces.
private static func scrollRowValue(_ y: Int) -> UInt8 {
    var h = UInt32(truncatingIfNeeded: y &+ 1)
    h = h &* 2_654_435_761; h ^= (h >> 15); h = h &* 2_246_822_519; h ^= (h >> 13)
    return UInt8(truncatingIfNeeded: h >> 24)
}

private static func stripCompressionForDownScroll(dy: Int, width: Int, height: Int, congestionLevel: Double) throws -> OwnedGraphicsTileCompression {
    var engine = ScrollDeltaEngine()
    let first = try makeBGRAFrame(width: width, height: height) { _, y in
        let v = scrollRowValue(y); return [v, v, v, 0xff]
    }
    #expect(engine.evaluate(first).kind == .reset)
    engine.commitPendingSurface()
    let band = PixelRect(x: 0, y: 0, width: width, height: height)
    let scrolled = try makeBGRAFrame(width: width, height: height, damageRects: [band], contentRectPixels: band) { _, y in
        let v = scrollRowValue(y - dy); return [v, v, v, 0xff]
    }
    let hint = ScrollActivityHint(axis: .vertical, sign: 1, predictedOffsetPx: dy, candidateOffsets: [dy], activeUntilUptimeNs: .max, eventCount: 4)
    let result = engine.evaluate(scrolled, scrollHint: hint, congestionLevel: congestionLevel)
    guard let strip = result.envelope?.commands.first(where: { $0.kindIsBitmapTile }),
          case let .bitmapTile(_, _, _, _, compression, _) = strip else {
        Issue.record("expected a scroll strip bitmap tile, got \(String(describing: result.diagnostics?.acceptedBy))")
        return .lzfse
    }
    return compression
}

@Test func largeFlickScrollStripIsLossyJpeg() throws {
    // dy=240 over a 640-wide band -> strip 640*240*4 = 614400 bytes >= 524288 threshold.
    let compression = try Self.stripCompressionForDownScroll(dy: 240, width: 640, height: 480, congestionLevel: 0)
    #expect(compression == .jpeg)
}

@Test func slowCalmScrollStripStaysLossless() throws {
    // dy=8 over a 640-wide band -> strip 640*8*4 = 20480 bytes, well under threshold, calm.
    let compression = try Self.stripCompressionForDownScroll(dy: 8, width: 640, height: 480, congestionLevel: 0)
    #expect(compression == .lzfse)
}

@Test func congestedSmallScrollStripIsLossyJpeg() throws {
    // Same small strip, but congested -> forced lossy.
    let compression = try Self.stripCompressionForDownScroll(dy: 8, width: 640, height: 480, congestionLevel: 1.0)
    #expect(compression == .jpeg)
}
```

- [ ] **Step 3: Run to verify failure.** Same xcodebuild command. Expected: the large-flick and congested tests fail (strip is still `.lzfse`), or compile error on `makeScrollEnvelope` arity once Step 4 starts. Confirm `largeFlickScrollStripIsLossyJpeg` fails with `.lzfse`.

- [ ] **Step 4: Extract `makeJpegTile`** from `makeJPEGFrameEnvelope` in `ScrollDeltaEngine.swift`. Replace the body of `makeJPEGFrameEnvelope` (773 onward) so the tile-building (clamp, tileData, optional downscale, compress, build `.bitmapTile`) lives in a reusable helper, behavior identical:

```swift
// One lossy JPEG bitmap tile over a rect. The tile command carries the full
// destination size; the JPEG may be encoded smaller (downscale) and the client
// upscales it. Shared by the fullframe fallback and the lossy scroll strip.
private func makeJpegTile(current: Surface, rect: PixelRect, quality: Double, scale: Double) -> (command: OwnedGraphicsCommand, payload: Data)? {
    let clamped = rect.clamped(toWidth: current.width, height: current.height)
    guard clamped.width > 0, clamped.height > 0,
          let bgra = tileData(surface: current, x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height) else { return nil }
    let scaledWidth = max(1, Int((Double(clamped.width) * scale).rounded()))
    let scaledHeight = max(1, Int((Double(clamped.height) * scale).rounded()))
    let encodeBytes: Data
    let encodeWidth: Int
    let encodeHeight: Int
    if scale < 1.0, scaledWidth < clamped.width, scaledHeight < clamped.height,
       let downscaled = downscaleBGRA(bgra, width: clamped.width, height: clamped.height, toWidth: scaledWidth, toHeight: scaledHeight) {
        encodeBytes = downscaled; encodeWidth = scaledWidth; encodeHeight = scaledHeight
    } else {
        encodeBytes = bgra; encodeWidth = clamped.width; encodeHeight = clamped.height
    }
    guard let jpeg = compressJPEGWithinBudget(encodeBytes, width: encodeWidth, height: encodeHeight, startQuality: quality) else { return nil }
    let command = OwnedGraphicsCommand.bitmapTile(
        x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height,
        compression: .jpeg, byteRange: OwnedGraphicsByteRange(offset: 0, length: jpeg.count)
    )
    return (command, jpeg)
}

private func makeJPEGFrameEnvelope(current: Surface, region: PixelRect, quality: Double, scale: Double, capturedAtUptimeNs: UInt64) -> OwnedGraphicsFrameEnvelope? {
    guard let tile = makeJpegTile(current: current, rect: region, quality: quality, scale: scale) else { return nil }
    return OwnedGraphicsFrameEnvelope(
        header: OwnedGraphicsFrameHeader(
            surfaceGeneration: surfaceGeneration,
            frameId: graphicsFrameId,
            capturedAtUptimeNs: capturedAtUptimeNs,
            commandCount: 1,
            payloadLength: tile.payload.count
        ),
        commands: [tile.command],
        payload: tile.payload
    )
}
```

- [ ] **Step 5: Make the strip adaptive in `makeScrollEnvelope`.** Change the signature to add `congestionLevel: Double, motion: Bool` (after `region`). Keep the copyRect + tile-geometry computation (538-562) exactly. Replace the LZFSE-only build (563-585) with:

```swift
        let stripRawBytes = tileWidth * tileHeight * 4
        let useLossy = congestionLevel > 0 || stripRawBytes >= Config.hybridScrollStripLossyThresholdBytes
        let stripCommand: OwnedGraphicsCommand
        let payload: Data
        if useLossy,
           let tile = makeJpegTile(
               current: current,
               rect: PixelRect(x: tileX, y: tileY, width: tileWidth, height: tileHeight),
               quality: fullframeQuality(forLevel: congestionLevel, motion: motion),
               scale: fullframeScale(forLevel: congestionLevel)
           ) {
            stripCommand = tile.command
            payload = tile.payload
        } else {
            guard let exposed = tileData(surface: current, x: tileX, y: tileY, width: tileWidth, height: tileHeight),
                  let compressed = compressLZFSE(exposed) else { return nil }
            stripCommand = .bitmapTile(
                x: tileX, y: tileY, width: tileWidth, height: tileHeight,
                compression: .lzfse, byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
            )
            payload = compressed
        }
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: 2,
                payloadLength: payload.count
            ),
            commands: [copyCommand, stripCommand],
            payload: payload
        )
```

- [ ] **Step 6: Thread level + motion at the `.scroll` call site** (~628-633):

```swift
            guard let envelope = makeScrollEnvelope(
                current: current,
                offset: offset,
                region: region,
                congestionLevel: congestionLevel,
                motion: scrollHint != nil,
                capturedAtUptimeNs: frame.capturedAtUptimeNs
            ) else {
```

- [ ] **Step 7: Run host build+test, expect green.** Same xcodebuild command. Expected `TEST SUCCEEDED`, the three new strip tests pass.

- [ ] **Step 8: `just check` then commit + push.**

```bash
just check
git add host/AgentDeskHost/Config.swift host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift
git commit -m "feat: lossy JPEG exposed scroll strips on fast flicks and congestion"
git push origin HEAD
```

---

## Verification (after both tasks)

- `just check` green (host + client).
- Device run `just host-run` (host-only, no client reinstall) on the thin-wifi setup; read `tools/hybrid-graphics-diagnostics-summary.sh`.
- Acceptance: copyRect payload max/avg drop materially (the ~133KB LZFSE strip tail collapses) with no new copyRect tearing; congested fullframes degrade and recover smoothly across a scroll burst with no persistent macroblock squares; generation stays stable; fps no worse than working-version-11.
