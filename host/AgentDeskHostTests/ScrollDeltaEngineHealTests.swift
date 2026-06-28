import CoreGraphics
import CoreVideo
import Testing
@testable import AgentDeskHost

// ADR-0022 periodic heal. macOS dirtyRects are not always complete: moving the
// cursor heals the vacated pixels on the real screen, but ScreenCaptureKit may not
// report that region as damaged, so the host commits a clean baseline while the
// client keeps the stale cursor (a trail). Every healIntervalFrames change-carrying
// frames, the engine promotes the frame to a full-surface re-tile that bypasses
// rung-1, re-emitting every grid cell (drawCachedTile for cached content, cacheTile
// for the rest) so the client repaints the whole surface and reconciles. Idle
// (.noChange) frames do not advance the heal counter, so a static screen is never
// needlessly repainted.
struct ScrollDeltaEngineHealTests {

    // With healIntervalFrames=2, two small single-cell changes elapse, then the
    // second one is promoted to a heal: the result re-emits ALL four grid cells of
    // the 256x256 surface (not just the one changed cell), and the diagnostics label
    // it damage-heal. The frame after the heal is a normal small frame again,
    // proving the counter reset.
    @Test func periodicHealReemitsWholeSurfaceBypassingRung1() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,   // never JPEG
            healIntervalFrames: 2
        )
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)
        let topLeft = PixelRect(x: 0, y: 0, width: 128, height: 128)
        let allCells: Set<[Int]> = [[0, 0], [128, 0], [0, 128], [128, 128]]

        // Frame 0: uniform background -> reset, whole surface becomes the baseline.
        let bg = try Self.makeBGRAFrame(width: side, height: side) { _, _ in [10, 10, 10, 0xff] }
        #expect(engine.evaluate(bg).kind == .reset)
        engine.commitPendingSurface()

        // Frame 1: change only the top-left cell. A single small damage rect tiles to
        // just that cell, so the result must NOT cover the whole surface.
        let change1 = try Self.makeBGRAFrame(width: side, height: side, damageRects: [topLeft], contentRectPixels: full) { x, y in
            (x < 128 && y < 128) ? [UInt8((x &+ y) & 0xff), 20, 30, 0xff] : [10, 10, 10, 0xff]
        }
        let r1 = engine.evaluate(change1)
        #expect(r1.kind == .accepted)
        #expect(Self.cells(in: r1) != allCells, "a single-cell change must not re-send the whole surface")
        engine.commitPendingSurface()

        // Frame 2: change the top-left cell again. This is the 2nd change-carrying
        // frame, so it is promoted to a heal: all four cells re-emit, labelled
        // damage-heal, even though three of them equal the baseline (rung-1 bypassed).
        let change2 = try Self.makeBGRAFrame(width: side, height: side, damageRects: [topLeft], contentRectPixels: full) { x, y in
            (x < 128 && y < 128) ? [40, UInt8((x &+ y) & 0xff), 50, 0xff] : [10, 10, 10, 0xff]
        }
        let r2 = engine.evaluate(change2)
        #expect(r2.kind == .accepted)
        #expect(r2.diagnostics?.acceptedBy == "damage-heal")
        #expect(Self.cells(in: r2) == allCells, "a heal re-emits every grid cell of the surface")
        engine.commitPendingSurface()

        // Frame 3: another single-cell change. The heal counter reset, so this is a
        // normal small frame again, not a heal.
        let change3 = try Self.makeBGRAFrame(width: side, height: side, damageRects: [topLeft], contentRectPixels: full) { x, y in
            (x < 128 && y < 128) ? [60, 70, UInt8((x &+ y) & 0xff), 0xff] : [10, 10, 10, 0xff]
        }
        let r3 = engine.evaluate(change3)
        #expect(r3.kind == .accepted)
        #expect(r3.diagnostics?.acceptedBy != "damage-heal", "the frame after a heal is a normal frame")
        #expect(Self.cells(in: r3) != allCells, "the counter reset, so this is not a whole-surface heal")
    }

    // healIntervalFrames=0 disables the heal entirely: no frame is ever promoted to a
    // whole-surface re-send, however many changes elapse.
    @Test func healDisabledNeverPromotes() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,
            healIntervalFrames: 0
        )
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)
        let topLeft = PixelRect(x: 0, y: 0, width: 128, height: 128)

        let bg = try Self.makeBGRAFrame(width: side, height: side) { _, _ in [10, 10, 10, 0xff] }
        #expect(engine.evaluate(bg).kind == .reset)
        engine.commitPendingSurface()

        for i in 0..<6 {
            let change = try Self.makeBGRAFrame(width: side, height: side, damageRects: [topLeft], contentRectPixels: full) { x, y in
                (x < 128 && y < 128) ? [UInt8((x &+ y &+ i) & 0xff), 20, 30, 0xff] : [10, 10, 10, 0xff]
            }
            let r = engine.evaluate(change)
            #expect(r.diagnostics?.acceptedBy != "damage-heal", "heal disabled must never promote a frame")
            engine.commitPendingSurface()
        }
    }

    // Per-row luma so a vertical shift is measurable and a frame classifies as scroll.
    private static func scrollRowValue(_ y: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: y &+ 1)
        h = h &* 2_654_435_761; h ^= (h >> 15); h = h &* 2_246_822_519; h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    // The heal fires during sustained scrolling: scroll frames advance the heal
    // counter like any change, and because the heal check precedes the scroll arm, a
    // heal-due frame re-tiles the WHOLE surface (reconciling any divergence the
    // copyRect path left) instead of emitting another copyRect. This is the repair
    // path for a skipped (missing-slot) strip tile on the client.
    @Test func healFiresDuringSustainedScroll() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,   // never JPEG
            healIntervalFrames: 2
        )
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)
        let allCells: Set<[Int]> = [[0, 0], [128, 0], [0, 128], [128, 128]]

        let base = try Self.makeBGRAFrame(width: side, height: side) { _, y in
            let v = Self.scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // Frame 1: a real vertical scroll (1st change frame). Accepted as scroll.
        let scroll1 = try Self.makeBGRAFrame(width: side, height: side, damageRects: [full], contentRectPixels: full) { _, y in
            let v = Self.scrollRowValue(y - 16); return [v, v, v, 0xff]
        }
        let r1 = engine.evaluate(scroll1, motion: MotionSignal(axis: .vertical, sign: 1))
        #expect(r1.diagnostics?.acceptedBy == "scroll")
        engine.commitPendingSurface()

        // Frame 2: another scroll, but this is the 2nd change frame, so the heal fires
        // first and re-tiles the whole surface rather than emitting a copyRect.
        let scroll2 = try Self.makeBGRAFrame(width: side, height: side, damageRects: [full], contentRectPixels: full) { _, y in
            let v = Self.scrollRowValue(y - 32); return [v, v, v, 0xff]
        }
        let r2 = engine.evaluate(scroll2, motion: MotionSignal(axis: .vertical, sign: 1))
        #expect(r2.diagnostics?.acceptedBy == "damage-heal")
        #expect(Self.cells(in: r2) == allCells, "the heal re-emits every grid cell during a scroll")
        let hasCopyRect = r2.envelopes.flatMap { $0.commands }.contains { if case .copyRect = $0 { return true }; return false }
        #expect(!hasCopyRect, "a heal-due frame heals the whole surface, it does not copyRect")
    }

    // Collect the set of [x, y] grid-cell origins addressed by a result's commands
    // across all of its progressive envelopes.
    private static func cells(in result: ScrollDeltaResult) -> Set<[Int]> {
        var out: Set<[Int]> = []
        for envelope in result.envelopes {
            for cmd in envelope.commands {
                switch cmd {
                case let .cacheTile(_, x, y, _, _, _, _):
                    out.insert([x, y])
                case let .drawCachedTile(_, x, y, _, _):
                    out.insert([x, y])
                default:
                    break
                }
            }
        }
        return out
    }

    private static func makeBGRAFrame(
        width: Int,
        height: Int,
        damageRects: [PixelRect] = [],
        contentRectPixels: PixelRect? = nil,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferIOSurfacePropertiesKey: [:],
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw SessionRejected(reason: .malformed)
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            for x in 0..<width {
                let bytes = pixel(x, y)
                let offset = y * bytesPerRow + x * 4
                baseAddress.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0,
            damageRects: damageRects,
            contentRectPixels: contentRectPixels
        )
    }
}
