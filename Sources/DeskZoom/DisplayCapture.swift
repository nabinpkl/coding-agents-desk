import CoreMedia
import Foundation
import ScreenCaptureKit

/// What a running capture covers, and how finely. Restarting a stream is expensive, so the app asks
/// whether the capture it already has is good enough before aiming a new one.
struct CapturePlan: Equatable {
    let region: CGRect
    let pixelSize: CGSize

    /// True when this capture already shows everything `visible` needs at close enough to the wanted
    /// detail. Too few pixels reads as blur; far too many is wasted window-server work every frame.
    func satisfies(visible: CGRect, pixelsPerPoint wanted: CGFloat, tolerance: CGFloat) -> Bool {
        guard region.width > 0, region.contains(visible) else { return false }
        let have = pixelSize.width / region.width
        return have >= wanted * (1 - tolerance) && have <= wanted * (1 + tolerance)
    }
}

/// Streams one region of a display and hands each frame to `onFrame` on the main thread, together with
/// the source rect those pixels actually cover so the view can place them exactly.
///
/// Changing region starts a *fresh* stream rather than reconfiguring the running one. `updateConfiguration`
/// keeps delivering the previous region for at least one frame, and ScreenCaptureKit emits no frames at all
/// while a display is idle, so on a static desktop a reconfigured stream never repaints. A fresh stream
/// delivers its first frame immediately, with the new region, and its identity tells us which region the
/// pixels belong to. (Verified 2026-09-04 with a capture probe.)
final class DisplayCapture {
    private let displayID: CGDirectDisplayID
    private var current: Feed?
    private var incoming: Feed?
    /// Looked up once. `SCShareableContent` is a window-server-wide query, and running it per re-aim while
    /// the view followed the cursor was a large part of what pushed WindowServer to 40% CPU and stalled
    /// typing across the machine.
    private var shareableDisplay: SCDisplay?

    /// Called on the main thread with a frame and the region of the display it covers.
    /// The buffer owns the IOSurface, so keep it alive while it is displayed.
    var onFrame: ((CMSampleBuffer, CGRect) -> Void)?
    /// Called on the main thread if a stream dies on its own. Fail loud: the caller decides what to do.
    var onStop: ((Error) -> Void)?

    init(displayID: CGDirectDisplayID) {
        self.displayID = displayID
    }

    /// What the frames now on screen cover, or nil before the first stream has delivered.
    var plan: CapturePlan? { current.map { CapturePlan(region: $0.sourceRect, pixelSize: $0.pixelSize) } }

    /// Starts capturing `sourceRect`. The previous stream keeps running, and keeps painting, until the new
    /// one has produced a frame, so there is no black gap while switching.
    func setRegion(sourceRect: CGRect, outputPixelSize: CGSize) async throws {
        let display = try await resolveDisplay()
        let feed = Feed(sourceRect: sourceRect, pixelSize: outputPixelSize)
        feed.onFirstFrame = { [weak self] in self?.promote(feed) }
        feed.onFrame = { [weak self] buffer in self?.onFrame?(buffer, sourceRect) }
        feed.onStop = { [weak self] error in self?.onStop?(error) }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: Self.configuration(sourceRect: sourceRect, outputPixelSize: outputPixelSize), delegate: feed)
        try stream.addStreamOutput(feed, type: .screen, sampleHandlerQueue: feed.queue)
        feed.stream = stream

        incoming?.stop()
        incoming = feed
        try await stream.startCapture()
    }

    func stop() async {
        let feeds = [current, incoming].compactMap { $0 }
        current = nil
        incoming = nil
        for feed in feeds { await feed.stopAndWait() }
    }

    private func resolveDisplay() async throws -> SCDisplay {
        if let shareableDisplay { return shareableDisplay }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw DeskZoomError.captureDisplayNotShareable(displayID)
        }
        shareableDisplay = display
        return display
    }

    private func promote(_ feed: Feed) {
        guard incoming === feed else { return }
        current?.stop()
        current = feed
        incoming = nil
    }

    private static func configuration(sourceRect: CGRect, outputPixelSize: CGSize) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.sourceRect = sourceRect
        config.width = Int(outputPixelSize.width.rounded())
        config.height = Int(outputPixelSize.height.rounded())
        config.pixelFormat = kCVPixelFormatType_32BGRA
        // The viewer draws the cursor itself from the live mouse position; a captured cursor lags a frame or two.
        config.showsCursor = false
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        // The view holds the frame it is displaying so the IOSurface underneath it is not recycled, so the
        // pool needs spares to render the next one into. At a depth of 1 the stream delivered exactly one
        // frame and then froze forever. Stale frames are not a concern here: each stream carries its own
        // region, so a frame can never be attributed to the wrong one.
        config.queueDepth = 3
        return config
    }
}

/// One stream and the region it captures. Kept separate so a frame is never attributed to the wrong region.
private final class Feed: NSObject, SCStreamOutput, SCStreamDelegate {
    let sourceRect: CGRect
    let pixelSize: CGSize
    let queue = DispatchQueue(label: "deskzoom.capture.samples")
    var stream: SCStream?

    var onFrame: ((CMSampleBuffer) -> Void)?
    var onFirstFrame: (() -> Void)?
    var onStop: ((Error) -> Void)?

    private var sawFirstFrame = false
    private var isStopping = false

    init(sourceRect: CGRect, pixelSize: CGSize) {
        self.sourceRect = sourceRect
        self.pixelSize = pixelSize
    }

    func stop() {
        guard let stream, !isStopping else { return }
        isStopping = true
        Task { try? await stream.stopCapture() }
        self.stream = nil
    }

    func stopAndWait() async {
        guard let stream, !isStopping else { return }
        isStopping = true
        self.stream = nil
        try? await stream.stopCapture()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !isStopping, type == .screen, sampleBuffer.isValid, CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw),
              status == .complete
        else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isStopping else { return }
            if !self.sawFirstFrame {
                self.sawFirstFrame = true
                self.onFirstFrame?()
            }
            self.onFrame?(sampleBuffer)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard !isStopping else { return }
        DispatchQueue.main.async { [weak self] in
            self?.onStop?(DeskZoomError.captureStopped(error))
        }
    }
}
