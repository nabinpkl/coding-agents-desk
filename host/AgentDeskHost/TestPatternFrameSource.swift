import CoreVideo
import Foundation

// Diagnostic VideoFrameSource that emits a moving color band at 30 Hz.
// Used by R8.6.3 to verify the host-to-client pipeline without granting
// Screen Recording permission. ScreenCaptureKitFrameSource replaces it
// in R8.6.5 by way of MediaStack.makeFrameSource().

final class TestPatternFrameSource: VideoFrameSource, @unchecked Sendable {
    private var timerTask: Task<Void, Never>?
    private let width = 1280
    private let height = 720
    private let frameIntervalNs: UInt64 = 33_333_333  // 30 Hz

    init() {}

    func start(onFrame: @escaping @Sendable (CapturedVideoFrame) -> Void) async throws {
        timerTask?.cancel()
        timerTask = Task { [weak self, onFrame] in
            var frameIndex: UInt64 = 0
            let startNs = DispatchTime.now().uptimeNanoseconds
            while !Task.isCancelled {
                if let buffer = self?.makePixelBuffer(frameIndex: frameIndex) {
                    let nowNs = DispatchTime.now().uptimeNanoseconds - startNs
                    let frame = CapturedVideoFrame(
                        pixelBuffer: buffer,
                        presentationTimeNs: Int64(nowNs),
                        rotation: ._0
                    )
                    onFrame(frame)
                }
                frameIndex &+= 1
                try? await Task.sleep(nanoseconds: self?.frameIntervalNs ?? 33_333_333)
            }
        }
    }

    func stop() {
        timerTask?.cancel()
        timerTask = nil
    }

    private func makePixelBuffer(frameIndex: UInt64) -> CVPixelBuffer? {
        var buffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:],
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &buffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer = buffer else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        let band = Int(frameIndex % 256)
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let offset = x * 4
                let intensity = UInt8((x + Int(band)) % 256)
                row[offset + 0] = intensity            // B
                row[offset + 1] = UInt8((y + Int(band)) % 256)   // G
                row[offset + 2] = UInt8(255 - intensity)         // R
                row[offset + 3] = 255                  // A
            }
        }
        return pixelBuffer
    }
}
