import CoreImage
import CoreVideo
import Foundation
import AgentDeskWire

enum OwnedMediaFrameScalerError: Error {
    case pixelBufferAllocationFailed
}

final class OwnedMediaFrameScaler: @unchecked Sendable {
    private let context: CIContext

    init(context: CIContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])) {
        self.context = context
    }

    func scaledFrame(_ frame: CapturedVideoFrame, scaleDown: Double) throws -> CapturedVideoFrame {
        let effectiveScaleDown = max(scaleDown, 1.0)
        guard effectiveScaleDown > 1.0 else { return frame }

        let sourceWidth = CVPixelBufferGetWidth(frame.pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(frame.pixelBuffer)
        let outputWidth = Self.evenDimension(Double(sourceWidth) / effectiveScaleDown)
        let outputHeight = Self.evenDimension(Double(sourceHeight) / effectiveScaleDown)
        guard outputWidth != sourceWidth || outputHeight != sourceHeight else { return frame }

        var output: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            outputWidth,
            outputHeight,
            CVPixelBufferGetPixelFormatType(frame.pixelBuffer),
            [
                kCVPixelBufferIOSurfacePropertiesKey: [:],
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &output
        )
        guard status == kCVReturnSuccess, let output else {
            throw OwnedMediaFrameScalerError.pixelBufferAllocationFailed
        }

        let source = CIImage(cvPixelBuffer: frame.pixelBuffer)
        let scaleX = CGFloat(outputWidth) / CGFloat(max(sourceWidth, 1))
        let scaleY = CGFloat(outputHeight) / CGFloat(max(sourceHeight, 1))
        let scaled = source
            .applyingFilter(
                "CILanczosScaleTransform",
                parameters: [
                    kCIInputScaleKey: scaleY,
                    kCIInputAspectRatioKey: scaleX / max(scaleY, .leastNonzeroMagnitude)
                ]
            )
            .cropped(to: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

        context.render(scaled, to: output)
        Self.stampColorAttachments(output)
        return CapturedVideoFrame(
            pixelBuffer: output,
            presentationTimeNs: frame.presentationTimeNs,
            capturedAtUptimeNs: frame.capturedAtUptimeNs,
            rotation: frame.rotation
        )
    }

    // Delegated so the client's ladder labels and the frames this emits round identically.
    // Two copies that merely looked alike would drift, and the symptom would be a slider
    // reading 1663 x 1080 next to a 1662 x 1080 frame, which nobody would think to check.
    static func evenDimension(_ value: Double) -> Int {
        MediaResolutionLadder.evenDimension(value)
    }

    private static func stampColorAttachments(_ pixelBuffer: CVPixelBuffer) {
        CVBufferSetAttachment(
            pixelBuffer,
            kCVImageBufferColorPrimariesKey,
            kCVImageBufferColorPrimaries_ITU_R_709_2,
            .shouldPropagate
        )
        CVBufferSetAttachment(
            pixelBuffer,
            kCVImageBufferYCbCrMatrixKey,
            kCVImageBufferYCbCrMatrix_ITU_R_709_2,
            .shouldPropagate
        )
        CVBufferSetAttachment(
            pixelBuffer,
            kCVImageBufferTransferFunctionKey,
            kCVImageBufferTransferFunction_ITU_R_709_2,
            .shouldPropagate
        )
    }
}
