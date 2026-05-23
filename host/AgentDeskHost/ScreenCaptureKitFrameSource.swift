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
    let frames: AsyncStream<CapturedVideoFrame>
    private let continuation: AsyncStream<CapturedVideoFrame>.Continuation
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "capture")
    private let sampleQueue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.scstream", qos: .userInteractive)
    private var stream: SCStream?

    override init() {
        var continuation: AsyncStream<CapturedVideoFrame>.Continuation!
        frames = AsyncStream(bufferingPolicy: .bufferingNewest(2)) { continuation = $0 }
        self.continuation = continuation
        super.init()
    }

    func start() async throws {
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
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.width = display.width
        config.height = display.height
        config.queueDepth = 5
        config.showsCursor = true

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
        logger.notice("screen capture started \(display.width, privacy: .public)x\(display.height, privacy: .public)")
    }

    func stop() {
        let captured = stream
        stream = nil
        continuation.finish()
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
        let ts = sampleBuffer.presentationTimeStamp
        let timeNs = Int64(CMTimeGetSeconds(ts) * 1_000_000_000)
        let frame = CapturedVideoFrame(
            pixelBuffer: imageBuffer,
            presentationTimeNs: timeNs,
            rotation: ._0
        )
        continuation.yield(frame)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logger.error("scstream stopped with error: \(String(describing: error), privacy: .public)")
        continuation.finish()
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
