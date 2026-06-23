import CoreVideo
import Testing
@testable import AgentDeskHost

// H4: resetSurface fires only on connect (first frame, no retained surface)
// and on a surface-dimension change. Content churn, however heavy, never
// emits a full-surface reset; it emits tiles over the reliable channel. This
// eliminates the reset storm where large damage used to re-baseline the whole
// surface on every churned frame.
struct ResetPolicyTests {
    @Test func resetFiresOnlyOnFirstFrameAndResize() throws {
        var engine = ScrollDeltaEngine(useDamageClassifier: true)
        let width = 256
        let height = 256
        let fullSquare = PixelRect(x: 0, y: 0, width: width, height: height)

        // First frame after connect: no retained surface yet, so reset.
        let a = try Self.makeNoiseFrame(
            width: width,
            height: height,
            damageRects: [fullSquare],
            contentRectPixels: fullSquare,
            seed: 1
        )
        let r1 = engine.evaluate(a)
        #expect(r1.envelope?.commands.contains { $0.kindIsReset } == true)
        engine.commitPendingSurface()

        // Same-size frame with full-surface damage and different content. This
        // is content churn, not a connect or resize, so no reset: it routes to
        // tiles via the damage path.
        let b = try Self.makeNoiseFrame(
            width: width,
            height: height,
            damageRects: [fullSquare],
            contentRectPixels: fullSquare,
            seed: 2
        )
        let r2 = engine.evaluate(b)
        #expect(r2.envelope?.commands.contains { $0.kindIsReset } == false)
        #expect(r2.envelope?.commands.contains { $0.kindIsBitmapTile } == true)
        engine.commitPendingSurface()

        // Width change: a genuine surface-dimension change re-baselines, so reset.
        let wideSquare = PixelRect(x: 0, y: 0, width: 320, height: height)
        let c = try Self.makeNoiseFrame(
            width: 320,
            height: height,
            damageRects: [wideSquare],
            contentRectPixels: wideSquare,
            seed: 3
        )
        let r3 = engine.evaluate(c)
        #expect(r3.envelope?.commands.contains { $0.kindIsReset } == true)
    }

    private static func makeNoiseFrame(
        width: Int,
        height: Int,
        damageRects: [PixelRect] = [],
        contentRectPixels: PixelRect? = nil,
        seed: Int
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
                let v = UInt8((x * 37 + y * 101 + seed * 53) & 0xff)
                let offset = y * bytesPerRow + x * 4
                baseAddress.storeBytes(of: v, toByteOffset: offset, as: UInt8.self)
                baseAddress.storeBytes(of: v, toByteOffset: offset + 1, as: UInt8.self)
                baseAddress.storeBytes(of: v, toByteOffset: offset + 2, as: UInt8.self)
                baseAddress.storeBytes(of: 0xff, toByteOffset: offset + 3, as: UInt8.self)
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
