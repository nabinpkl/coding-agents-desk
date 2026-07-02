import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import os

// ADR-0004 production VideoFrameSource impl, host side. Captures the
// selected display via ScreenCaptureKit at native pixel size and 60 Hz,
// using the configured capture pixel format. Selection comes from the
// input-channel client config and falls back to the first display.

final class ScreenCaptureKitFrameSource: NSObject, VideoFrameSource, DisplaySelectableVideoFrameSource, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "capture")
    private let sampleQueue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).scstream", qos: .userInteractive)
    private let baseScaleDownBy: Double
    private let pixelFormat: OSType
    private var stream: SCStream?
    private let controlState = OSAllocatedUnfairLock(
        initialState: CaptureControlState()
    )

    init(
        scaleDownBy: Double = 1.0,
        pixelFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        selectedDisplayIdProvider: @escaping @Sendable () -> String? = { nil }
    ) {
        self.baseScaleDownBy = max(scaleDownBy, 1.0)
        self.pixelFormat = pixelFormat
        super.init()
        controlState.withLock { state in
            state.selectedDisplayId = selectedDisplayIdProvider()
        }
    }

    func start(onFrame: @escaping @Sendable (CapturedVideoFrame) -> Void) async throws {
        controlState.withLock { state in
            state.onFrame = onFrame
            state.isRunning = true
            state.forceKeyframeNextFrame = true
        }
        try await startCurrentSelection()
    }

    func selectDisplay(id: String?) {
        let shouldRestart = controlState.withLock { state -> Bool in
            let changed = state.selectedDisplayId != id
            state.selectedDisplayId = id
            return changed && state.isRunning && state.onFrame != nil
        }
        guard shouldRestart else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.restartCurrentSelection()
        }
    }

    private func startCurrentSelection() async throws {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            logger.error("SCShareableContent failed: \(String(describing: error), privacy: .public)")
            throw ScreenCaptureError.permissionDenied
        }
        guard let display = selectDisplay(from: content.displays) else {
            throw ScreenCaptureError.noDisplay
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        // Owned media can request alternate pixel formats for ceiling probes.
        // YUV formats keep an explicit matrix tag so the receiver uses
        // matching coefficients.
        config.pixelFormat = pixelFormat
        if pixelFormat != kCVPixelFormatType_32BGRA {
            config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        }
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
        // Capture always runs at native resolution. The media quality ladder's
        // resolutionScale is applied later in the encode pump (see
        // QuicSessionHostMediaTransport.videoFrameForEncode), so capture never
        // downsamples and the crisp emitter keeps full pixels.
        let scale = Self.backingScale(for: display.displayID)
        let pixelSize = CaptureSizing.pixelSize(
            displayWidthPoints: display.width,
            displayHeightPoints: display.height,
            backingScale: Double(scale),
            scaleDownBy: baseScaleDownBy
        )
        config.width = pixelSize.width
        config.height = pixelSize.height
        // queueDepth=3 minimizes capture-side buffering while staying within
        // SCStreamConfiguration's valid range (3..8). queueDepth=1 silently
        // makes the stream stop delivering frames altogether. Default 5
        // buffers ~165 ms; 3 buffers ~100 ms. The remaining latency budget
        // has to come from the encode and wire paths.
        config.queueDepth = 3
        config.showsCursor = true
        // Without an explicit color space, SCStream's BGRA arrives untagged.
        // Without a tag, downstream conversion can use a different range
        // assumption and true black (0,0,0) can surface as grey on the phone.
        // Tagging sRGB keeps the gamma curve aligned with the Mac display.
        config.colorSpaceName = CGColorSpace.sRGB

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
        logger.notice("screen capture started \(pixelSize.width, privacy: .public)x\(pixelSize.height, privacy: .public) backingScale=\(scale, privacy: .public) captureScaleDown=\(self.baseScaleDownBy, privacy: .public) pixelFormat=\(Self.fourCC(self.pixelFormat), privacy: .public)")
    }

    private func selectDisplay(from displays: [SCDisplay]) -> SCDisplay? {
        let selectedDisplayId = controlState.withLock { $0.selectedDisplayId }
        if let cgDisplayId = HostDisplayResolver.displayID(forSkyLightId: selectedDisplayId),
           let selected = displays.first(where: { $0.displayID == cgDisplayId }) {
            return selected
        }
        return displays.first
    }

    // Restart capture for a display switch. Resolution changes no longer restart
    // capture (the ladder downscales in the encode pump), so this path is now
    // display-selection only.
    private func restartCurrentSelection() async {
        let oldStream = stream
        stream = nil
        if let oldStream {
            try? await oldStream.stopCapture()
        }
        let callback = controlState.withLock { state -> (@Sendable (CapturedVideoFrame) -> Void)? in
            state.forceKeyframeNextFrame = true
            return state.onFrame
        }
        guard let callback else { return }
        do {
            try await start(onFrame: callback)
        } catch {
            logger.error("screen capture display switch failed: \(String(describing: error), privacy: .public)")
        }
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

    private static func fourCC(_ value: OSType) -> String {
        let bytes: [UInt8] = [
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff)
        ]
        return String(bytes: bytes, encoding: .macOSRoman) ?? "????"
    }

    func stop() {
        controlState.withLock { state in
            state.isRunning = false
            state.onFrame = nil
        }
        let captured = stream
        stream = nil
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
        // they propagate into the encoded stream. SCStream tags the buffer
        // when colorSpaceName is set, but re-stamping here covers the case
        // where attachments get dropped during conversion.
        CVBufferSetAttachment(imageBuffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(imageBuffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(imageBuffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        let ts = sampleBuffer.presentationTimeStamp
        let timeNs = Int64(CMTimeGetSeconds(ts) * 1_000_000_000)
        let pixelWidth = CVPixelBufferGetWidth(imageBuffer)
        let pixelHeight = CVPixelBufferGetHeight(imageBuffer)
        // ADR-0021: carry the OS damage region so the encode pump can drive
        // copyRect/tile from what actually changed instead of pixel-diffing the
        // whole frame. Read but do not log per frame: a prior os_log on this
        // 60fps sample queue re-froze the session.
        let damage = Self.damageRects(from: sampleBuffer, pixelWidth: pixelWidth, pixelHeight: pixelHeight)
        let output = controlState.withLock { state -> (Bool, (@Sendable (CapturedVideoFrame) -> Void)?) in
            let force = state.forceKeyframeNextFrame
            state.forceKeyframeNextFrame = false
            return (force, state.onFrame)
        }
        let frame = CapturedVideoFrame(
            pixelBuffer: imageBuffer,
            presentationTimeNs: timeNs,
            capturedAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
            rotation: ._0,
            forceKeyframe: output.0,
            damageRects: damage,
            contentRectPixels: PixelRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
        )
        output.1?(frame)
    }

    // Extract SCStreamFrameInfoDirtyRects as native pixel rects. Returns empty
    // for any frame that is not a complete capture or carries no usable damage,
    // which the classifier reads as "refresh the whole frame".
    //
    // A device spike (logged raw, ScreenCaptureKitFrameSource history) confirmed
    // the dirty rects arrive already in native pixel-buffer space on this path:
    // a full-frame dirty rect logged as 3600x2338 for an 1800x1169-point display
    // at 2x backing scale, i.e. equal to the pixel buffer, so no scaleFactor
    // multiply is applied here. The rects use the pixel buffer's top-left origin;
    // a wrong origin convention would fail the classifier's stripe verification
    // and degrade to a full-frame refresh rather than tearing the copy.
    private static func damageRects(from sampleBuffer: CMSampleBuffer, pixelWidth: Int, pixelHeight: Int) -> [PixelRect] {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
            let info = attachments.first else {
            return []
        }
        let statusRaw = (info[.status] as? Int) ?? -1
        guard statusRaw == SCFrameStatus.complete.rawValue else { return [] }
        let rawRects = (info[.dirtyRects] as? [Any]) ?? []
        var rects: [PixelRect] = []
        rects.reserveCapacity(rawRects.count)
        for element in rawRects {
            guard let dictionary = element as? NSDictionary,
                  let cgRect = CGRect(dictionaryRepresentation: dictionary) else { continue }
            let rect = PixelRect.clampedPixels(from: cgRect, width: pixelWidth, height: pixelHeight)
            if rect.area > 0 { rects.append(rect) }
        }
        return rects
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logger.error("scstream stopped with error: \(String(describing: error), privacy: .public)")
        controlState.withLock { state in
            state.onFrame = nil
            state.isRunning = false
        }
    }

    // MARK: - Permission helper

    static func hasScreenRecordingPermission() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    static func requestScreenRecordingPermission() {
        _ = CGRequestScreenCaptureAccess()
    }
}

private struct CaptureControlState: Sendable {
    var selectedDisplayId: String?
    var isRunning = false
    var forceKeyframeNextFrame = true
    var onFrame: (@Sendable (CapturedVideoFrame) -> Void)?
}

enum ScreenCaptureError: Error {
    case noDisplay
    case permissionDenied
}
