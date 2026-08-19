import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import os
import AgentDeskWire

// ADR-0004 production VideoFrameSource impl, host side. Captures the
// selected display via ScreenCaptureKit at native pixel size and 60 Hz,
// using the configured capture pixel format. Selection comes from the
// input-channel client config; a selection that names a display which is not
// attached is refused rather than quietly swapped (see selectDisplay).

final class ScreenCaptureKitFrameSource: NSObject, VideoFrameSource, TargetSelectableVideoFrameSource, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
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
            state.target = .display(selectedDisplayIdProvider())
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

    func restartCapture() {
        let running = controlState.withLock { $0.isRunning && $0.onFrame != nil }
        guard running else { return }
        Task { [weak self] in
            await self?.restartCurrentSelection()
        }
    }

    func selectCaptureTarget(_ target: CaptureTarget) {
        let shouldRestart = controlState.withLock { state -> Bool in
            let changed = state.target != target
            state.target = target
            // A target switch invalidates the previous target's availability verdict: the
            // new one has not reported anything yet, and carrying the old "unavailable"
            // across would suppress the first genuine transition.
            if changed { state.lastReportedAvailability = nil }
            return changed && state.isRunning && state.onFrame != nil
        }
        guard shouldRestart else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.restartCurrentSelection()
        }
    }

    func setCaptureAvailabilityHandler(_ handler: @escaping @Sendable (CaptureAvailability) -> Void) {
        controlState.withLock { $0.onAvailability = handler }
    }

    func setShowsCursorInVideo(_ enabled: Bool) {
        // showsCursor is a start-time SCStreamConfiguration field, so a change while running
        // restarts capture to rebuild the config (same path as a display switch). This is a
        // rare, user-initiated settings toggle, so the brief keyframe is acceptable.
        let shouldRestart = controlState.withLock { state -> Bool in
            let changed = state.showsCursorInVideo != enabled
            state.showsCursorInVideo = enabled
            return changed && state.isRunning && state.onFrame != nil
        }
        guard shouldRestart else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.restartCurrentSelection()
        }
    }

    private func startCurrentSelection() async throws {
        let target = controlState.withLock { $0.target }
        // onScreenWindowsOnly must be false for a window target: the windows most worth
        // streaming to a phone are the ones sitting on another Space, and `true` filters
        // exactly those out. Harmless for the display branch, which reads content.displays.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: !target.isWindow
            )
        } catch {
            logger.error("SCShareableContent failed: \(String(describing: error), privacy: .public)")
            throw ScreenCaptureError.permissionDenied
        }
        if case let .window(windowID) = target {
            try await startWindowCapture(windowID: windowID, content: content)
            return
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
        // `SCDisplay.width`/`.height` and `filter.contentRect` are documented points; on
        // Retina the actual framebuffer is points * backing scale pixels. Setting
        // config.width/.height to the point value (what we used to do) makes SCK
        // downsample the framebuffer to half resolution before encode, leaving text
        // consistently soft on the phone.
        //
        // The scale comes from the filter, not from an NSScreen lookup keyed by
        // displayID. The filter is the same object we are about to capture through and
        // it already knows the exact density of its own content, so there is no lookup
        // to miss and no 2.0 default to be wrong about -- which is how the window branch
        // below has always done it.
        //
        // Capture always runs at native resolution. The media quality ladder's
        // resolutionScale is applied later in the encode pump (see
        // QuicSessionHostMediaTransport.videoFrameForEncode), so capture never
        // downsamples and the crisp emitter keeps full pixels.
        let scale = Double(filter.pointPixelScale)
        let contentRect = filter.contentRect
        let pixelSize = CaptureSizing.pixelSize(
            widthPoints: Double(contentRect.width),
            heightPoints: Double(contentRect.height),
            backingScale: scale,
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
        config.showsCursor = controlState.withLock { $0.showsCursorInVideo }
        // Without an explicit color space, SCStream's BGRA arrives untagged.
        // Without a tag, downstream conversion can use a different range
        // assumption and true black (0,0,0) can surface as grey on the phone.
        // Tagging sRGB keeps the gamma curve aligned with the Mac display.
        config.colorSpaceName = CGColorSpace.sRGB

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
        let displayIdentity = HostDisplayResolver.skyLightId(for: display.displayID) ?? "cgID:\(display.displayID)"
        logger.notice("screen capture started display=\(displayIdentity, privacy: .public) points=\(Int(contentRect.width), privacy: .public)x\(Int(contentRect.height), privacy: .public) \(pixelSize.width, privacy: .public)x\(pixelSize.height, privacy: .public) pointPixelScale=\(scale, privacy: .public) captureScaleDown=\(self.baseScaleDownBy, privacy: .public) pixelFormat=\(Self.fourCC(self.pixelFormat), privacy: .public)")
    }

    // Stream one window through `SCContentFilter(desktopIndependentWindow:)`.
    //
    // Sizing comes from the filter's own `contentRect` and `pointPixelScale`, the same way
    // the display branch above does it: the filter already knows the exact backing scale
    // for whichever display the window sits on. Dimensions are forced even for the encoder.
    //
    // A window resized after this point keeps streaming into the dimensions captured here,
    // scaled to fit. That is imperfect, not broken; live reconfiguration through
    // `updateContentFilter`/`updateConfiguration` is deliberately a follow-up.
    private func startWindowCapture(windowID: CGWindowID, content: SCShareableContent) async throws {
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            logger.error("capture target window \(windowID, privacy: .public) not found")
            throw ScreenCaptureError.noWindow
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = Double(filter.pointPixelScale)
        let rect = filter.contentRect
        let config = SCStreamConfiguration()
        config.pixelFormat = pixelFormat
        if pixelFormat != kCVPixelFormatType_32BGRA {
            config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        }
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        let pixelSize = CaptureSizing.pixelSize(
            widthPoints: Double(rect.width),
            heightPoints: Double(rect.height),
            backingScale: scale,
            scaleDownBy: baseScaleDownBy
        )
        config.width = pixelSize.width
        config.height = pixelSize.height
        config.queueDepth = 3
        config.showsCursor = controlState.withLock { $0.showsCursorInVideo }
        config.colorSpaceName = CGColorSpace.sRGB

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
        let appName = window.owningApplication?.applicationName ?? "?"
        logger.notice("window capture started wid=\(windowID, privacy: .public) app=\(appName, privacy: .public) \(pixelSize.width, privacy: .public)x\(pixelSize.height, privacy: .public) pointPixelScale=\(scale, privacy: .public) onScreen=\(window.isOnScreen, privacy: .public)")
    }

    // Resolve the selected display, or nothing.
    //
    // This used to fall back to `displays.first` when the selection did not resolve, which
    // is why "50%" meant two different pixel densities on two different days: with the
    // laptop closed, capture quietly streamed the external monitor while the client's
    // picker still named the built-in, and the resolution ladder is a fraction of whatever
    // capture produced. The substitution itself was reasonable; doing it here, silently,
    // where nothing could report it, was not.
    //
    // Choosing a display is now the selection store's job (DisplaySelectionStore.reconcile,
    // driven by the screen-parameters observer), so an unplugged display is replaced before
    // capture ever reads it -- and the client is told. A miss reaching this point therefore
    // means a genuinely unresolvable target, which belongs on the wire as `.unavailable`
    // rather than as a picture of some other screen.
    private func selectDisplay(from displays: [SCDisplay]) -> SCDisplay? {
        var selectedDisplayId: String?
        if case let .display(id) = controlState.withLock({ $0.target }) {
            selectedDisplayId = id
        }
        // No selection at all is not the case this guards against: nothing has been asked
        // for yet, so there is no client belief to contradict. That happens on a launch
        // where capture beats the first desktop-state read, and the main display is the
        // only sensible answer. It is logged because "which display did we default to"
        // is exactly the question the old silent fallback made unanswerable.
        guard let selectedDisplayId else {
            let main = displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? displays.first
            logger.notice("capture target display unset; defaulting to main display cgID=\(main?.displayID ?? 0, privacy: .public)")
            return main
        }
        guard let cgDisplayId = HostDisplayResolver.displayID(forSkyLightId: selectedDisplayId),
              let selected = displays.first(where: { $0.displayID == cgDisplayId }) else {
            logger.error("capture target display \(selectedDisplayId, privacy: .public) is not attached; not substituting another")
            return nil
        }
        return selected
    }

    // Restart capture for a capture-target switch (display to display, display to
    // window, window to window) or a showsCursor toggle. Resolution changes no longer
    // restart capture, since the ladder downscales in the encode pump.
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
            logger.error("screen capture target switch failed: \(String(describing: error), privacy: .public)")
            // The target is gone and no stream exists to report a frame status, so this is
            // the only place the failure can become a signal. Without it the client holds
            // its last frame with a healthy decoder, which reads as a freeze.
            report(.unavailable(reason: "capture-start-failed"))
        }
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
            state.lastReportedAvailability = nil
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
        guard type == .screen, sampleBuffer.isValid else { return }
        // Status is read once here and handed down, rather than re-read inside the damage
        // helper. It is also the only signal a window target has when it stops being
        // capturable: minimizing it or hiding its app yields `suspended` frames and then
        // silence, with no stream error at all.
        let status = Self.frameStatus(from: sampleBuffer)
        report(availability(for: status))
        guard let imageBuffer = sampleBuffer.imageBuffer else { return }
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
        let damage = status == .complete
            ? Self.damageRects(from: sampleBuffer, pixelWidth: pixelWidth, pixelHeight: pixelHeight)
            : []
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

    // nil when the attachment is missing or carries an unknown raw value. Callers must
    // treat nil as "no verdict" rather than as failure: the pre-existing behaviour is to
    // still deliver such a frame, just without damage.
    private static func frameStatus(from sampleBuffer: CMSampleBuffer) -> SCFrameStatus? {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
            let info = attachments.first,
            let raw = info[.status] as? Int else { return nil }
        return SCFrameStatus(rawValue: raw)
    }

    // nil means the status carries no health verdict. `idle` is the normal
    // nothing-changed-since-the-last-frame case and `started` is a one-off, so neither
    // says anything about whether the target is still capturable.
    private func availability(for status: SCFrameStatus?) -> CaptureAvailability? {
        switch status {
        case .complete: return .available
        case .suspended: return .unavailable(reason: "window-suspended")
        case .stopped: return .unavailable(reason: "capture-stopped")
        case .blank: return .unavailable(reason: "capture-blank")
        default: return nil
        }
    }

    // Transition-only, and window targets only. A display target has never reported
    // capture health, and a transient `blank` on the daily-driver display path would put
    // an outage banner on the phone for a frame.
    private func report(_ availability: CaptureAvailability?) {
        guard let availability else { return }
        let handler = controlState.withLock { state -> (@Sendable (CaptureAvailability) -> Void)? in
            guard state.target.isWindow, state.lastReportedAvailability != availability else { return nil }
            state.lastReportedAvailability = availability
            return state.onAvailability
        }
        handler?(availability)
    }

    // Extract SCStreamFrameInfoDirtyRects as native pixel rects. Returns empty when the
    // frame carries no usable damage geometry, which the classifier reads as "refresh the
    // whole frame". Callers gate this on a complete frame status.
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
    var target: CaptureTarget = .display(nil)
    var isRunning = false
    var forceKeyframeNextFrame = true
    var onFrame: (@Sendable (CapturedVideoFrame) -> Void)?
    var onAvailability: (@Sendable (CaptureAvailability) -> Void)?
    // Last verdict handed to onAvailability. Reporting is transition-only: capture
    // status arrives per frame at 60 Hz and the consumer drives user-visible chrome.
    var lastReportedAvailability: CaptureAvailability?
    // Composite the OS cursor into the captured video? Default off; the client's overlay is
    // the cursor. A client can turn it on via ClientConfig (setShowsCursorInVideo).
    var showsCursorInVideo = false
}

enum ScreenCaptureError: Error {
    case noDisplay
    case noWindow
    case permissionDenied
}
