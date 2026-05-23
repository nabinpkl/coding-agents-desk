import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import os
import os.lock

// ADR-0004 production VideoFrameSource impl, host side. Captures the
// first available display via ScreenCaptureKit at native pixel size and
// 30 Hz, in BGRA. The display picker for multi-monitor selection is a
// v1 follow-up; v0 captures `displays.first` which is the main display
// in single-display setups.

final class ScreenCaptureKitFrameSource: NSObject, VideoFrameSource, RegionalVideoFrameSource, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "capture")
    private let sampleQueue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.scstream", qos: .userInteractive)
    private var stream: SCStream?
    // Set in start() and cleared in stop(). Read from the SCStream sample
    // queue, written from the start/stop caller — those don't overlap, so
    // the lack of synchronization is intentional.
    private var onFrame: (@Sendable (CapturedVideoFrame) -> Void)?
    // ADR-0007 viewport crop. Stored in normalized 0..1 source coords;
    // nil = full display. Locked because setSourceRect is called from
    // AppDelegate (MainActor / the input-channel handler), while
    // start/stop and the apply path run from other contexts.
    private struct CropState {
        var normalized: CGRect?
        var lastAppliedDisplayWidth: Int = 0
        var lastAppliedDisplayHeight: Int = 0
    }
    private let cropState = OSAllocatedUnfairLock<CropState>(initialState: CropState())

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
        // ADR-0007: record the display dimensions so a later setSourceRect
        // call (or a re-apply at start) can map normalized rects into
        // points. SCDisplay isn't Sendable; copy its int dims out first
        // so the lock closure doesn't capture a non-Sendable display.
        let dispW = display.width
        let dispH = display.height
        cropState.withLock { s in
            s.lastAppliedDisplayWidth = dispW
            s.lastAppliedDisplayHeight = dispH
        }
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
        config.width = display.width
        config.height = display.height
        // queueDepth=3 minimizes capture-side buffering while staying within
        // SCStreamConfiguration's valid range (3..8). queueDepth=1 silently
        // makes the stream stop delivering frames altogether. Default 5
        // buffers ~165 ms; 3 buffers ~100 ms. The remaining latency budget
        // has to come from the encode and wire paths.
        config.queueDepth = 3
        config.showsCursor = true
        // ADR-0007: apply any client-requested crop captured before the
        // stream started. Computed under the same lock setSourceRect
        // uses so a concurrent setSourceRect can't race the start.
        let initialCrop = cropState.withLock { $0.normalized }
        if let normalized = initialCrop {
            applyCropToConfig(config, normalized: normalized, display: display)
        }
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
        logger.notice("screen capture started \(display.width, privacy: .public)x\(display.height, privacy: .public)")
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
            rotation: ._0
        )
        onFrame?(frame)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logger.error("scstream stopped with error: \(String(describing: error), privacy: .public)")
        onFrame = nil
    }

    // MARK: - ADR-0007 viewport crop

    func setSourceRect(_ normalizedRect: CGRect?) {
        // Sanity-clamp normalized rect into 0..1 and reject zero-size.
        let sanitized: CGRect?
        if let r = normalizedRect {
            let x = max(0, min(1, r.minX))
            let y = max(0, min(1, r.minY))
            let w = max(0, min(1 - x, r.width))
            let h = max(0, min(1 - y, r.height))
            sanitized = (w > 0.01 && h > 0.01) ? CGRect(x: x, y: y, width: w, height: h) : nil
        } else {
            sanitized = nil
        }

        let snapshot = cropState.withLock { s -> CropState in
            s.normalized = sanitized
            return s
        }

        // Stream is live; reconfigure in place. SCStream.updateConfiguration
        // is supported on macOS 14+; the host already targets macos14.0.
        guard let stream, snapshot.lastAppliedDisplayWidth > 0 else { return }

        let newConfig = SCStreamConfiguration()
        // Mirror the values set in start(); SCStreamConfiguration is
        // value-y but constructed fresh per update.
        newConfig.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        newConfig.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        newConfig.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        newConfig.queueDepth = 3
        newConfig.showsCursor = true
        newConfig.colorSpaceName = CGColorSpace.sRGB

        // Output frame size stays pinned to the full display in both
        // branches. On crop, only sourceRect changes so SCK maps the
        // sub-rect into the same-size output frame, which gives more
        // output pixels per source pixel (the density gain). Resizing
        // the output frame to match the crop would cancel that gain.
        newConfig.width = snapshot.lastAppliedDisplayWidth
        newConfig.height = snapshot.lastAppliedDisplayHeight
        if let normalized = sanitized {
            applyCropToConfigDimensions(
                newConfig,
                normalized: normalized,
                displayWidth: snapshot.lastAppliedDisplayWidth,
                displayHeight: snapshot.lastAppliedDisplayHeight
            )
            logger.notice("setSourceRect crop=\(normalized.minX, privacy: .public),\(normalized.minY, privacy: .public),\(normalized.width, privacy: .public)x\(normalized.height, privacy: .public)")
        } else {
            logger.notice("setSourceRect reset to full display")
        }

        stream.updateConfiguration(newConfig) { [logger] error in
            if let error {
                logger.error("updateConfiguration failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // Sets sourceRect, width, and height together so the encoded frame
    // is the cropped slice at native source density (not a stretched
    // version of the original full-display dimensions). Called from
    // start() against a brand-new config and from setSourceRect against
    // the live updateConfiguration path.
    private func applyCropToConfig(
        _ config: SCStreamConfiguration,
        normalized: CGRect,
        display: SCDisplay
    ) {
        applyCropToConfigDimensions(
            config,
            normalized: normalized,
            displayWidth: display.width,
            displayHeight: display.height
        )
    }

    private func applyCropToConfigDimensions(
        _ config: SCStreamConfiguration,
        normalized: CGRect,
        displayWidth: Int,
        displayHeight: Int
    ) {
        let w = CGFloat(displayWidth)
        let h = CGFloat(displayHeight)
        config.sourceRect = CGRect(
            x: normalized.minX * w,
            y: normalized.minY * h,
            width: normalized.width * w,
            height: normalized.height * h
        )
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
