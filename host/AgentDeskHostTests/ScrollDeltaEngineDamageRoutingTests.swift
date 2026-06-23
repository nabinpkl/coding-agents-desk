import CoreVideo
import Testing
@testable import AgentDeskHost

// H1: with the damage path on, the two non-scroll classifier outcomes
// (.fullFrame and .tiles) both emit a tile envelope over the reliable
// graphics channel instead of falling back to HEVC. .noChange yields a
// result with no envelope and no fallback flag.
struct ScrollDeltaEngineDamageRoutingTests {
    @Test func fullFrameOutcomeProducesTileEnvelopeNotRejection() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        // Prime a solid surface (reset).
        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Deliver a frame whose damage covers the whole surface with content
        // that differs everywhere and no scroll hint. The classifier returns
        // .fullFrame, which H1 routes to a tile envelope.
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let churned = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            let v = UInt8((x * 37 + y * 101) & 0xff)
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(churned, scrollHint: nil)

        #expect(result.envelope != nil)
        #expect(result.envelope?.commands.contains { $0.kindIsBitmapTile } == true)
        #expect(result.fellBackToHEVC == false)
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
