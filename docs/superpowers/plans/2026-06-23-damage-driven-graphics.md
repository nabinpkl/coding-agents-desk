# Damage-Driven Single-Channel Graphics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the host media producer to a single reliable damage-driven graphics path (copyRect for scroll, LZFSE tiles for everything else), deleting the HEVC encoder, the datagram media channel, the admission/floor/hysteresis layer, and the brute-force pixel-diff scroll probe, with backpressure provided by a simple unacked-frame cap.

**Architecture:** ADR-0021 already built the damage spine: `ScreenCaptureKitFrameSource` reads `dirtyRects`, `CapturedVideoFrame` carries them, `DamageScrollClassifier.classifyTraced` returns `.scroll`/`.tiles`/`.fullFrame`/`.noChange` (with an input-corroborated copyRect path), `ScrollDeltaEngine.makeScrollEnvelope`/`makeTileEnvelope` assemble `OwnedGraphicsFrameEnvelope`s, and the client `OwnedSurfaceCompositor` applies them with LZFSE tile decode and frame-acks. This plan removes everything that competes with that spine and reroutes the two non-scroll classifier outcomes (`.fullFrame`, `.tiles`) to tile envelopes instead of HEVC. The wire format does not change.

**Tech Stack:** Swift, two Xcode projects (`host/AgentDeskHost.xcodeproj` scheme `AgentDeskHost`, `client/AgentDeskClient.xcodeproj` scheme `AgentDeskClient`), Network.framework QUIC, ScreenCaptureKit, VideoToolbox (host encoder, being deleted), Apple `Compression` framework (LZFSE), swift-testing.

## Global Constraints

- No em-dashes in code comments or docs. Use commas, periods, or "and". (CLAUDE.md)
- No hardcoded configs. URLs, ports, paths, tunables go through `Config.swift`. (AGENTS.md)
- Pre-v0: breaking changes are free; delete dead code rather than keeping it dormant. (AGENTS.md)
- Tile compression stays **LZFSE** (`OwnedGraphicsTileCompression.lzfse`), already wired host and client. The design's "LZ4" meant "cheap fast raw-tile compression, no image/video codec"; LZFSE fills that role. Do not introduce LZ4.
- Tile grid is **fixed 128x128** in surface pixel space. New constant `Config.hybridTileGridPx`, default 128.
- Backpressure: producer holds at most `Config.hybridMaxUnackedFrames` unacked graphics frames, default 2.
- `resetSurface` fires only on connect and surface-dimension change. Never for content.
- Build/test: `just check` runs both schemes' `build test` via xcodebuild. Host tests live in `host/AgentDeskHostTests/`, client tests in the client test target. Run the host scheme's `build test` after every host task; the client scheme after every client task.
- Auto-commit each green task. Commit co-author line: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Do NOT commit the other agent's WIP files: `tools/hybrid-graphics-diagnostics-summary.sh`, `tools/hybrid-graphics-diagnostics-summary-tests.sh`, `tests/fixtures/owned-media/hybrid-freeze-host.log`.

## Parallelization map (for the coordinator)

Host and client are independent Xcode targets and the wire is unchanged, so two tracks run in parallel, then a sequential integration validates the whole:

- **Track H (host), sequential within itself:** Tasks H1 -> H2 -> H3 -> H4 -> H5. Centered on `OwnedMediaTransport.swift`, `ScrollDeltaEngine.swift`, `SharedTypes.swift`, `Config.swift`. Cannot be internally parallelized (shared files).
- **Track C (client), parallel with Track H:** Task C1. Centered on client `OwnedMediaVideoSink.swift` and client `OwnedMediaTransport.swift`. Independent target.
- **Integration (sequential, after H and C):** Task I1 full `just check`; Task I2 device validation (HITL, needs the physical iPhone).

Each track keeps its own target green at every task. Track C never depends on Track H because the wire is fixed.

---

## Track H: host producer collapse

### Task H1: Force the damage path on, reroute non-scroll outcomes to tiles

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (the `evaluate` -> brute-probe vs `evaluateWithDamage` branch around 312-320; the result mapping in `evaluateWithDamage` ~790-890)
- Modify: `host/AgentDeskHost/Config.swift:312` (`hybridDamageDrivenScroll`)
- Test: `host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift` (create)

**Interfaces:**
- Consumes: `DamageScrollClassification` cases `.scroll(region:dx:dy:)`, `.tiles([PixelRect])`, `.fullFrame(reason:)`, `.noChange`; existing `makeScrollEnvelope(...)`, `makeTileEnvelope(...)`, `ScrollDeltaResult`.
- Produces: a `ScrollDeltaResult` where `.fullFrame` and `.tiles` both yield a tile `OwnedGraphicsFrameEnvelope` (never a "rejected -> HEVC" signal), and `.noChange` yields an explicit "nothing to send" result.

- [ ] **Step 1: Write the failing test** — a large-damage frame (classifier returns `.fullFrame`) must produce a tile envelope, not a rejection.

```swift
import Testing
@testable import AgentDeskHost

@Test func fullFrameOutcomeProducesTileEnvelopeNotRejection() {
    var engine = ScrollDeltaEngine(
        maxDecodedResetStripePayloadBytes: 2_000_000,
        maxWireResetStripeBytes: 196_608,
        viewportConfig: ScrollViewportConfig.defaultForTests(),
        useDamageClassifier: true
    )
    // Prime a surface, then deliver a frame whose damage covers most of it
    // with no consistent scroll offset (forces .fullFrame).
    let first = TestFrames.solid(width: 256, height: 256, luma: 10)
    _ = engine.evaluate(first)
    let churned = TestFrames.noise(width: 256, height: 256, damageCoversAll: true)
    let result = engine.evaluate(churned)
    #expect(result.envelope != nil)
    #expect(result.envelope?.commands.contains { $0.kindIsBitmapTile } == true)
    #expect(result.fellBackToHEVC == false)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -derivedDataPath build/dd build test -only-testing:AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests`
Expected: FAIL (compile error on `fellBackToHEVC` / `kindIsBitmapTile`, or assertion failure because `.fullFrame` currently routes to rejection).

- [ ] **Step 3: Make minimal changes**
  - In `Config.swift`, change `hybridDamageDrivenScroll` default to `true` (the damage path is now the only path; the flag remains as a kill-switch for one more cycle, then is removed in H5).
  - In `evaluateWithDamage`, change the result mapping so `.fullFrame(reason:)` and `.tiles(rects)` both call the tile-envelope builder over the damaged region (see H2 for grid snapping; here just route them through `makeTileEnvelope`), and `.noChange` returns a result with `envelope == nil` and no fallback flag set.
  - Add a small helper `OwnedGraphicsCommand.kindIsBitmapTile` and a `ScrollDeltaResult.fellBackToHEVC` accessor (or rename the existing rejection signal) so the producer can tell "nothing to send" from "send this envelope". Do not yet delete the HEVC plumbing; H3 does that.

- [ ] **Step 4: Run test to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHost/Config.swift host/AgentDeskHostTests/ScrollDeltaEngineDamageRoutingTests.swift
git commit -m "feat(host): route fullFrame/tiles classifier outcomes to tile envelopes

Damage path becomes the only scroll path. Non-scroll change emits tiles
over the reliable channel instead of falling back to HEVC.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task H2: Fixed 128x128 grid tile emission

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (`makeTileEnvelope` ~860-890, and `makeScrollEnvelope`'s exposed-strip emission ~740-780)
- Modify: `host/AgentDeskHost/Config.swift` (add `hybridTileGridPx`)
- Test: `host/AgentDeskHostTests/TileGridEmissionTests.swift` (create)

**Interfaces:**
- Consumes: damaged `[PixelRect]`, `current` surface pixels, `compressLZFSE`, `OwnedGraphicsCommand.bitmapTile(x:y:width:height:compression:byteRange:)`.
- Produces: one `bitmapTile` command per 128x128 grid cell overlapped by damage, each cell clipped to surface bounds, payload LZFSE-compressed BGRA.

- [ ] **Step 1: Write the failing test** — damage spanning a 200x200 region at origin must emit 4 grid tiles (cells (0,0),(128,0),(0,128),(128,128)), each <=128x128.

```swift
import Testing
@testable import AgentDeskHost

@Test func damageSnapsToFixed128Grid() {
    let cells = TileGrid.cells(
        covering: [PixelRect(x: 0, y: 0, width: 200, height: 200)],
        surfaceWidth: 256, surfaceHeight: 256, gridPx: 128
    )
    #expect(cells.count == 4)
    #expect(cells.allSatisfy { $0.width <= 128 && $0.height <= 128 })
    #expect(cells.contains(PixelRect(x: 0, y: 0, width: 128, height: 128)))
    #expect(cells.contains(PixelRect(x: 128, y: 128, width: 72, height: 72)))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `xcodebuild ... -only-testing:AgentDeskHostTests/TileGridEmissionTests`
Expected: FAIL (`TileGrid` undefined).

- [ ] **Step 3: Implement `TileGrid.cells`** — pure function snapping a damage rect list to grid cells.

```swift
enum TileGrid {
    /// Grid cells (clipped to the surface) overlapped by any damage rect.
    static func cells(covering damage: [PixelRect], surfaceWidth: Int, surfaceHeight: Int, gridPx: Int) -> [PixelRect] {
        var seen = Set<Int>()
        var out: [PixelRect] = []
        for rect in damage {
            let cx0 = (max(0, rect.x) / gridPx) * gridPx
            let cy0 = (max(0, rect.y) / gridPx) * gridPx
            let cx1 = min(surfaceWidth, rect.maxX)
            let cy1 = min(surfaceHeight, rect.maxY)
            var gy = cy0
            while gy < cy1 {
                var gx = cx0
                while gx < cx1 {
                    let key = (gy / gridPx) * (surfaceWidth / gridPx + 1) + (gx / gridPx)
                    if seen.insert(key).inserted {
                        let w = min(gridPx, surfaceWidth - gx)
                        let h = min(gridPx, surfaceHeight - gy)
                        if w > 0 && h > 0 { out.append(PixelRect(x: gx, y: gy, width: w, height: h)) }
                    }
                    gx += gridPx
                }
                gy += gridPx
            }
        }
        return out
    }
}
```

- [ ] **Step 4: Wire `TileGrid.cells` into `makeTileEnvelope`** — replace the single-union tile with one tile per cell (each cell's BGRA copied from `current`, LZFSE-compressed, appended to the envelope payload with its own `byteRange`). Add `Config.hybridTileGridPx` (default 128) and pass it through. Run both the new test and `TileGridEmissionTests`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHost/Config.swift host/AgentDeskHostTests/TileGridEmissionTests.swift
git commit -m "feat(host): emit damage as fixed 128x128 grid tiles

Bounds per-tile size and gives stable tile identity for a future
content-hash cache. Replaces the single damage-union tile.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task H3: Replace admission with an unacked-frame cap

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift` (the producer pump decision tree ~979-1356; the ack plumbing `noteGraphicsFrameAck` ~1704-1722)
- Modify: `host/AgentDeskHost/Config.swift` (add `hybridMaxUnackedFrames`)
- Test: `host/AgentDeskHostTests/UnackedFrameCapTests.swift` (create)

**Interfaces:**
- Consumes: `OwnedGraphicsFrameAck.frameId`, the sent-frame `frameId` counter.
- Produces: a `GraphicsBackpressure` value type with `func canProduce() -> Bool`, `mutating func noteSent(frameId:)`, `mutating func noteAck(frameId:)`, holding at most `maxUnacked` in flight.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import AgentDeskHost

@Test func backpressureStallsAtCapAndResumesOnAck() {
    var bp = GraphicsBackpressure(maxUnacked: 2)
    #expect(bp.canProduce())
    bp.noteSent(frameId: 1); bp.noteSent(frameId: 2)
    #expect(!bp.canProduce())          // at cap
    bp.noteAck(frameId: 1)
    #expect(bp.canProduce())           // one slot freed
}
```

- [ ] **Step 2: Run to verify it fails** — `-only-testing:AgentDeskHostTests/UnackedFrameCapTests`. Expected: FAIL (`GraphicsBackpressure` undefined).

- [ ] **Step 3: Implement `GraphicsBackpressure`** (highest-acked-frame watermark; in flight = sent - acked).

```swift
struct GraphicsBackpressure {
    let maxUnacked: Int
    private var lastSent: UInt64 = 0
    private var lastAcked: UInt64 = 0
    var inFlight: Int { Int(lastSent &- lastAcked) }
    func canProduce() -> Bool { inFlight < maxUnacked }
    mutating func noteSent(frameId: UInt64) { lastSent = max(lastSent, frameId) }
    mutating func noteAck(frameId: UInt64) { lastAcked = max(lastAcked, frameId) }
}
```

- [ ] **Step 4: Wire it into the pump** — in `runEncodePump`, before building/sending an envelope, `guard backpressure.canProduce() else { continue }` (the mailbox coalesces dirtyRects while stalled). Call `noteSent` after `graphicsChannel.send`, and `noteAck` from `noteGraphicsFrameAck`. Remove the `graphicsAdmission.noteAck` / severe-mode return values usage at the gate (the type itself is deleted in H5). Run `UnackedFrameCapTests` plus the host scheme `build test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/AgentDeskHost/OwnedMediaTransport.swift host/AgentDeskHost/Config.swift host/AgentDeskHostTests/UnackedFrameCapTests.swift
git commit -m "feat(host): gate production on an unacked-frame cap

Replaces the admission/floor/hysteresis/severe-mode layer with a
two-frame in-flight cap. Stalled frames coalesce in the mailbox.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task H4: resetSurface only on connect and resize

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` (surface reset/generation logic ~166-282)
- Test: `host/AgentDeskHostTests/ResetPolicyTests.swift` (create)

**Interfaces:**
- Consumes: current vs previous surface dimensions, connect state.
- Produces: a reset envelope only when (a) no surface yet (first frame after connect) or (b) width/height changed. Content churn never resets.

- [ ] **Step 1: Write the failing test** — two same-size frames with heavy damage produce at most one reset (the first), the second produces tiles/copyRect, not a reset.

```swift
@Test func resetFiresOnlyOnFirstFrameAndResize() {
    var engine = ScrollDeltaEngine(/* ...as H1... */ useDamageClassifier: true)
    let a = TestFrames.noise(width: 256, height: 256, damageCoversAll: true)
    let r1 = engine.evaluate(a)
    #expect(r1.envelope?.commands.contains { $0.kindIsReset } == true)   // first => reset
    let b = TestFrames.noise(width: 256, height: 256, damageCoversAll: true)
    let r2 = engine.evaluate(b)
    #expect(r2.envelope?.commands.contains { $0.kindIsReset } == false)  // churn => no reset
    let c = TestFrames.noise(width: 320, height: 256, damageCoversAll: true)
    let r3 = engine.evaluate(c)
    #expect(r3.envelope?.commands.contains { $0.kindIsReset } == true)   // resize => reset
}
```

- [ ] **Step 2: Run to verify it fails** — `-only-testing:AgentDeskHostTests/ResetPolicyTests`. Expected: FAIL (current logic resets on large damage / classifier churn -> the reset storm).

- [ ] **Step 3: Constrain reset emission** — gate reset generation strictly on `previousSurface == nil || previous.size != current.size`. Remove any path that emits a reset because damage was "too large" or the classifier returned `.fullFrame` (that now emits tiles, per H1). Add `kindIsReset` helper if needed.

- [ ] **Step 4: Run to verify it passes** — same command plus host `build test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/AgentDeskHost/ScrollDeltaEngine.swift host/AgentDeskHostTests/ResetPolicyTests.swift
git commit -m "fix(host): reset surface only on connect and resize

Eliminates the reset storm: content churn now emits tiles, never a
full-surface reset.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task H5: Make the damage path unconditional, delete the probe subsystem, HEVC, datagram, and admission

**Scope correction (option A).** The damage path was added (ADR-0021) as an opt-in alongside the live brute-force probe (`useDamageClassifier` defaults to false). H1-H4 made the damage path correct, but the probe path is still live as the non-damage branch, and ~20 scroll-quality tests drive it through the default `ScrollDeltaEngine()` constructor. The approved design deletes `ScrollDeltaProbe`/`ScrollViewportTracker` outright, so this task makes the damage path the ONLY path and removes the probe subsystem and its tests, then deletes HEVC/datagram/admission. This is a large task; multiple commits are acceptable as long as the host scheme is green at the end of each commit.

**Keep (do NOT delete):** `ScrollActivityTracker` / `ScrollActivityHint` (the input-hint source the damage classifier consumes via `hint.candidateOffsets`), `DamageScrollClassifier`, the damage-path tests added in H1-H4 (`ScrollDeltaEngineDamageRoutingTests`, `TileGridEmissionTests`, `UnackedFrameCapTests`, `ResetPolicyTests`), `DamageScrollClassifierTests`, `GraphicsBackpressure`.

**Files:**
- Modify: `host/AgentDeskHost/ScrollDeltaEngine.swift` — make `evaluate` always route through `evaluateWithDamage`; remove the probe branch and its helpers (`bestScrollOffset`, `makeDiagnostics`, `makeProbeSampler`, `isWholeWindowCopyRect`), the `viewportTracker` member and `ScrollViewportConfig` usage, and the `useDamageClassifier` parameter (now unconditional).
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift` — stop constructing `ScrollViewportConfig` and `ScrollCopyOwnership` and threading probe/viewport/region state through the pump; delete `VideoToolboxOwnedMediaEncoder`, `startQuicDatagramListener` and its connection handlers, and any leftover HEVC fallback blocks in the pump; remove the now-dead `graphicsAdmission` plumbing (`reset` calls and the type if unused).
- Modify: `host/AgentDeskHost/SharedTypes.swift` — delete `HybridScrollHEVCAdmission`, `HybridHEVCFallbackPolicy`, `HybridGraphicsRecoveryHEVCGate`, `OwnedHybridHEVCFallbackReason`, the `OwnedGraphicsAdmission` type if now unused, and host-only datagram media envelope types.
- Delete files (after confirming zero surviving references): `host/AgentDeskHost/ScrollDeltaProbe.swift`, `host/AgentDeskHost/ScrollViewportTracker.swift`, `host/AgentDeskHost/ScrollCopyOwnership.swift`, and `host/AgentDeskHost/ScrollRegionTracker.swift` if it becomes dead. Remove their `project.pbxproj` entries.
- Modify: `host/AgentDeskHost/Config.swift` — remove the `hybridDamageDrivenScroll` flag and now-dead HEVC/admission/viewport/floor/hysteresis/reset-stripe-ack constants.
- Modify: `host/AgentDeskHost/MediaStack.swift` — drop the datagram listener wiring and the HEVC encoder factory.
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift` — delete the HEVC-admission tests AND the ~20 probe-based tests that drive the deleted probe path (every test that constructs the default `ScrollDeltaEngine()` to exercise probe/viewport behavior, e.g. the `Hint*`, `Probe*`, `Viewport*`, `Region*`, baseline-realign, and timeout tests the H5 blocker enumerated). Remove the file if nothing meaningful remains; keep any test that exercises the surviving damage path.

**Interfaces:**
- Consumes: nothing new.
- Produces: a host target with exactly one media path (reliable damage-driven graphics). `tools/media-architecture-guard.sh` is a forbidden-pattern grep and does not assert on HEVC/datagram symbols, so deletion will not break it; adding a single-channel invariant assertion there is optional.

- [ ] **Step 1: Make the damage path unconditional** — in `ScrollDeltaEngine`, force `evaluate` through `evaluateWithDamage` and delete the probe branch + helpers + viewport member + `useDamageClassifier` param. Fix `OwnedMediaTransport` callers (drop the `useDamageClassifier:` argument and the `ScrollViewportConfig`/`ScrollCopyOwnership` construction). Compile the host scheme. Commit "refactor(host): make damage path the only scroll path".

- [ ] **Step 2: Delete the probe-based tests** — remove from `ScrollQualityTests.swift` every test that drove the now-deleted probe/viewport path (the enumerated ~20). Keep damage-path coverage. Run the host scheme `build test` green. Commit "test(host): drop probe-path scroll-quality tests".

- [ ] **Step 3: Delete the probe files** — delete `ScrollDeltaProbe.swift`, `ScrollViewportTracker.swift`, `ScrollCopyOwnership.swift` (and `ScrollRegionTracker.swift` if dead), remove `project.pbxproj` entries. Compile. Commit "refactor(host): delete dead probe/viewport files".

- [ ] **Step 4: Delete HEVC, datagram, admission** — delete `VideoToolboxOwnedMediaEncoder`, the datagram listener + handlers, leftover pump HEVC blocks, the `SharedTypes` admission/fallback types, the `MediaStack` datagram/encoder wiring, and prune dead `Config` constants and the `hybridDamageDrivenScroll` flag. Comment-compile loop until the host scheme builds.

- [ ] **Step 5: Run the full host suite + guard, commit**

Run: `xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -derivedDataPath build/dd build test` then `sh tools/media-architecture-guard.sh`. Expected: both PASS.

```bash
git add host/AgentDeskHost host/AgentDeskHostTests host/AgentDeskHost.xcodeproj/project.pbxproj
git commit -m "refactor(host): delete HEVC encoder, datagram channel, and admission

Single reliable graphics path only. Removes VideoToolboxOwnedMediaEncoder,
the datagram media listener, and HybridScrollHEVCAdmission/FallbackPolicy/
RecoveryGate, completing the collapse to the damage-driven graphics path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Track C: client HEVC deletion (parallel with Track H)

### Task C1: Delete the client HEVC decode path and datagram transport

**Files:**
- Modify: `client/AgentDeskClient/OwnedMediaVideoSink.swift` (delete `OwnedHEVCFrameDecoder` ~422-481; the HEVC branch of `renderOwnedMediaFrame` ~67-197; the `displayLayer` if unused). Keep `OwnedSurfaceCompositor`, `renderOwnedGraphicsFrame`, `decompressLZFSE`, `makeImage`, `surfaceLayer`.
- Modify: `client/AgentDeskClient/OwnedMediaTransport.swift` (delete the datagram `OwnedMediaTransport` class / `agentdesk-owned-media` connection ~301-927 and its repair buffer; keep `OwnedGraphicsTransport` and its receive loop). Remove the `startGraphicsChannel` caller's datagram `receiveTask`.
- Test: client test target (mirror the host test runner; add a focused test that `renderOwnedGraphicsFrame` still applies a reset+tile envelope and returns an ack).

**Interfaces:**
- Consumes: `OwnedGraphicsFrameEnvelope` (unchanged wire), `OwnedGraphicsFrameAck`.
- Produces: a client that connects only on the reliable `agentdesk-owned-graphics` ALPN, renders graphics frames, and acks. No HEVC, no datagram socket.

- [ ] **Step 1: Write the failing test** — a synthesized envelope (reset 64x64 + one bitmapTile) applied via `renderOwnedGraphicsFrame` returns an ack with matching `frameId` and a non-nil composited image.

```swift
import Testing
@testable import AgentDeskClient

@Test func graphicsOnlyClientRendersResetAndTile() throws {
    let sink = OwnedMediaVideoSink()   // or the test-accessible init
    let envelope = TestEnvelopes.resetPlusTile(width: 64, height: 64, frameId: 7)
    let ack = sink.renderOwnedGraphicsFrame(envelope)
    #expect(ack.frameId == 7)
    #expect(sink.debugCurrentImage() != nil)
}
```

- [ ] **Step 2: Run to verify it fails** — client scheme `build test`, only the new test. Expected: FAIL (helpers/test-hooks undefined) or build error once HEVC removal starts.

- [ ] **Step 3: Delete HEVC + datagram, add minimal test hooks** — remove the decoder, the HEVC render branch, and the datagram transport; add only the test accessors the test needs (`debugCurrentImage`). Keep all graphics rendering intact.

- [ ] **Step 4: Run the client suite**

Run: `xcodebuild -project client/AgentDeskClient.xcodeproj -scheme AgentDeskClient -derivedDataPath build/dd -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16 Pro Max' build test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/AgentDeskClient/OwnedMediaVideoSink.swift client/AgentDeskClient/OwnedMediaTransport.swift client/AgentDeskClientTests/
git commit -m "refactor(client): delete HEVC decode path and datagram transport

Client renders only the reliable graphics surface. Removes
OwnedHEVCFrameDecoder, the HEVC render branch, and the datagram media
connection. Compositor, tile decode, and acks unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integration

### Task I1: Full `just check`

- [ ] **Step 1: Run** `just check`. Expected: both schemes build and test green; all `tools/*-tests.sh` guards pass.
- [ ] **Step 2:** If the media-architecture guard or diagnostics-summary guard asserts on deleted symbols, update the guard to assert the new single-channel invariant (no datagram listener, no HEVC encoder) instead. Commit.

### Task I2: Device validation (HITL)

The physical iPhone run cannot be done by an agent; it needs the user. Acceptance criteria from the spec:
- No surface resets during a scroll (grep the host log for reset generations; expect 1 per connect, 0 during scroll).
- `copyRect` exercised during scroll (`acceptedBy=damage` > 0 in classifier trace).
- Client render gap stays below the freeze threshold (no multi-second `maxRenderGapMs`).
- Tile bytes bounded (no 15MB blasts; per-frame tile bytes ~ damaged-cell count * <=128*128*4 pre-LZFSE).

- [ ] **Step 1:** Coordinator asks the user to run `just fresh-hybrid-consoled-run` and exercise a scroll, preserving `/tmp/agentdesk-client-console.log` and the host log.
- [ ] **Step 2:** Coordinator runs `tools/hybrid-graphics-diagnostics-summary.sh` against the logs and checks the four criteria.
- [ ] **Step 3:** If green, write/refresh ADR-0021 follow-up (or a new ADR) recording the single-channel outcome and supersession of the HEVC-hybrid decision. Commit.

---

## Self-review

- **Spec coverage:** one channel (H5 deletes the datagram path) ✓; command set unchanged and reused ✓; producer loop = classifier + grid (H1, H2) ✓; frame-ack backpressure (H3) ✓; fixed 128 grid (H2) ✓; reset only on connect/resize (H4) ✓; deletions (H5, C1) ✓; LZFSE retained per global constraint ✓; tests + device acceptance (I1, I2) ✓.
- **Placeholder scan:** the only deliberately-open item is the exact line ranges inside H5's comment-compile loop, which are bounded by the cut-point table from exploration; no TBDs in code steps.
- **Type consistency:** `kindIsBitmapTile`/`kindIsReset` helpers introduced in H1/H4 and used in H1/H4 tests; `GraphicsBackpressure` API consistent H3 step 1 vs step 3; `TileGrid.cells` signature consistent H2 step 3 vs step 4.
