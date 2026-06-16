import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import os

// ADR-0004 production VideoFrameSource impl, host side. Captures the
// first available display via ScreenCaptureKit at native pixel size and
// 30 Hz, in BGRA. The display picker for multi-monitor selection is a
// v1 follow-up; v0 captures `displays.first` which is the main display
// in single-display setups.

final class ScreenCaptureKitFrameSource: NSObject, VideoFrameSource, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "capture")
    private let sampleQueue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.scstream", qos: .userInteractive)
    private var stream: SCStream?
    // Set in start() and cleared in stop(). Read from the SCStream sample
    // queue, written from the start/stop caller — those don't overlap, so
    // the lack of synchronization is intentional.
    private var onFrame: (@Sendable (CapturedVideoFrame) -> Void)?

    override init() {
        super.init()
    }

    func start(onFrame: @escaping @Sendable (CapturedVideoFrame) -> Void) async throws {
        self.onFrame = onFrame
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            logger.error("SCShareableContent failed: \(String(describing: error), privacy: .public)")
            throw ScreenCaptureError.permissionDenied
        }
        guard let display = content.displays.first else {
            throw ScreenCaptureError.noDisplay
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        // YUV full-range NV12 instead of BGRA. libwebrtc otherwise does its
        // own BGRA -> I420 conversion via libyuv, and that conversion plus
        // the encoder's range signaling plus the iPhone-side renderer's
        // offset together drift the black point by 16/255 (~6 percent grey).
        // Capturing as NV12 full-range hands YUV straight to the encoder
        // with no intermediate conversion, and colorMatrix tags the data
        // so the iPhone shader picks the matching coefficients.
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        // 60 fps cap so cursor motion has headroom. ScreenCaptureKit only
        // delivers when the framebuffer actually changes, so this doesn't
        // cost CPU when the screen is static; it just shortens the worst-case
        // capture-side latency from 33 ms to 17 ms.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        // ADR-0008: encode at native pixel density, not point density.
        // SCDisplay.width and .height are documented points; on Retina
        // the actual framebuffer is points * backingScaleFactor pixels.
        // Setting config.width/.height to the point value (what we used
        // to do) makes SCK downsample the framebuffer to half resolution
        // before encode, leaving text consistently soft on the phone.
        // The backing scale comes from NSScreen matched by displayID.
        let scale = Self.backingScale(for: display.displayID)
        let pixelW = Int((CGFloat(display.width) * scale).rounded())
        let pixelH = Int((CGFloat(display.height) * scale).rounded())
        config.width = pixelW
        config.height = pixelH
        // queueDepth=3 minimizes capture-side buffering while staying within
        // SCStreamConfiguration's valid range (3..8). queueDepth=1 silently
        // makes the stream stop delivering frames altogether. Default 5
        // buffers ~165 ms; 3 buffers ~100 ms. The remaining latency budget
        // has to come from the encode and wire paths.
        config.queueDepth = 3
        config.showsCursor = true
        // Without an explicit color space, SCStream's BGRA arrives untagged.
        // libwebrtc then converts to YUV with one range assumption while
        // RTCMTLVideoView on iOS renders with another, so true black (0,0,0)
        // surfaces as ~6% grey on the phone. Tagging sRGB lines both sides
        // up so blacks stay black and the gamma curve matches the Mac display.
        config.colorSpaceName = CGColorSpace.sRGB

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
        logger.notice("screen capture started \(pixelW, privacy: .public)x\(pixelH, privacy: .public) scale=\(scale, privacy: .public)")
    }

    // Pull the backing scale factor for a CGDirectDisplayID off NSScreen.
    // Falls back to 2.0 (the Retina default) if the displayID doesn't
    // resolve, which keeps a desk-clone monitor working without
    // exploding the encoder dimensions.
    private static func backingScale(for displayID: CGDirectDisplayID) -> CGFloat {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        for screen in NSScreen.screens {
            if let n = screen.deviceDescription[key] as? NSNumber, CGDirectDisplayID(n.uint32Value) == displayID {
                return screen.backingScaleFactor
            }
        }
        return 2.0
    }

    func stop() {
        let captured = stream
        stream = nil
        onFrame = nil
        guard let captured else { return }
        Task {
            do {
                try await captured.stopCapture()
            } catch {
                // stop errors are noise during teardown
            }
        }
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              sampleBuffer.isValid,
              let imageBuffer = sampleBuffer.imageBuffer else { return }
        // Belt-and-suspenders: stamp the per-frame color attachments so
        // they propagate into libwebrtc's I420 conversion and the encoded
        // VUI. SCStream tags the buffer when colorSpaceName is set, but
        // re-stamping here covers the case where the attachments get
        // dropped during the BGRA -> YUV conversion path.
        CVBufferSetAttachment(imageBuffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(imageBuffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(imageBuffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        let ts = sampleBuffer.presentationTimeStamp
        let timeNs = Int64(CMTimeGetSeconds(ts) * 1_000_000_000)
        let frame = CapturedVideoFrame(
            pixelBuffer: imageBuffer,
            presentationTimeNs: timeNs,
            capturedAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
            rotation: ._0
        )
        onFrame?(frame)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logger.error("scstream stopped with error: \(String(describing: error), privacy: .public)")
        onFrame = nil
    }

    // MARK: - Permission helper

    static func hasScreenRecordingPermission() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    static func requestScreenRecordingPermission() {
        _ = CGRequestScreenCaptureAccess()
    }
}

enum ScreenCaptureError: Error {
    case noDisplay
    case permissionDenied
}
