import AVFoundation
import Compression
import ImageIO
import UIKit
import os
import AgentDeskWire

protocol OwnedMediaFrameSink: VideoFrameSink {
    @MainActor func renderOwnedGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        queueDepth: OwnedGraphicsQueueDepth
    ) -> OwnedGraphicsFrameAck
    // ADR-0025: a decoded HEVC motion frame from the datagram carrier.
    @MainActor func renderOwnedVideoFrame(_ envelope: OwnedMediaFrameEnvelope, frameBytes: Int)
    @MainActor func currentGraphicsResetRequest(reason: String) -> OwnedGraphicsResetRequest
    @MainActor func consumePendingGraphicsResetRequest() -> OwnedGraphicsResetRequest?
    @MainActor func noteOwnedMediaDroppedFrames(_ count: Int)
    @MainActor func setOwnedMediaStatus(_ status: OwnedMediaStatus)
    @MainActor func noteOwnedMediaRepairRequested(_ count: Int)
    @MainActor func noteOwnedMediaRepairExpired(_ count: Int)
    @MainActor func setOwnedMediaExpectedFrameRate(_ fps: Int)
    // ADR-0027: the transport installs how the sink asks for a keyframe (the render
    // -stall watchdog and the wedged-layer recovery both use it).
    @MainActor func setVideoKeyframeRequestHandler(_ handler: @escaping @Sendable () -> Void)
    // ADR-0088: the transport installs where presentation skips are counted, so the waste
    // lands in the same 500ms link-health window as everything else rather than only in the
    // client's own three-run diagnostics store. Push rather than pull: `flushLinkHealth` is
    // synchronous and lock-based, and the sink is MainActor-isolated.
    @MainActor func setOwnedMediaPresentationSkipHandler(_ handler: @escaping @Sendable (Int) -> Void)
    // ADR-0090: where the sink reports that a long-term reference frame reached the decoder.
    // Installed by the transport, which turns it into the acknowledgement the host needs before
    // it may encode against that frame.
    @MainActor func setLtrAcknowledgementHandler(_ handler: @escaping @Sendable (UInt64) -> Void)
    // The sink publishes every media status change here. The diagnostics readout is fixed
    // chrome owned by the controller (like the gear and cursor dot), not a child of the
    // zoomable picture, so the sink no longer draws it; it only reports the status.
    @MainActor var onOwnedMediaStatusChange: ((OwnedMediaStatus) -> Void)? { get set }
    /// Adopt a new transport's stream while keeping the picture that is already on screen.
    ///
    /// A recovery re-dial builds a fresh host encoder, so frame ids restart and new parameter
    /// sets arrive. Decode and pacing state from the previous stream would misread that, but
    /// the displayed image must survive: it is the only thing standing between the user and a
    /// black screen for however long the network takes to come back, which was measured at
    /// ~9.5s of an 11s outage on a cellular switch.
    ///
    /// Same mechanism the render-stall watchdog already relies on -- reset the decoder and
    /// pacer, do not flush the layer.
    @MainActor func prepareForStreamHandover()
}

// Default no-ops so non-video conformers (test stubs) need not implement them.
extension OwnedMediaFrameSink {
    @MainActor func renderOwnedVideoFrame(_ envelope: OwnedMediaFrameEnvelope, frameBytes: Int) {}
    @MainActor func noteOwnedMediaDroppedFrames(_ count: Int) {}
    @MainActor func setOwnedMediaStatus(_ status: OwnedMediaStatus) {}
    @MainActor func prepareForStreamHandover() {}
    @MainActor func setLtrAcknowledgementHandler(_ handler: @escaping @Sendable (UInt64) -> Void) {}
    @MainActor func noteOwnedMediaRepairRequested(_ count: Int) {}
    @MainActor func noteOwnedMediaRepairExpired(_ count: Int) {}
    @MainActor func setOwnedMediaExpectedFrameRate(_ fps: Int) {}
    @MainActor func setVideoKeyframeRequestHandler(_ handler: @escaping @Sendable () -> Void) {}
    @MainActor func setOwnedMediaPresentationSkipHandler(_ handler: @escaping @Sendable (Int) -> Void) {}
    @MainActor var onOwnedMediaStatusChange: ((OwnedMediaStatus) -> Void)? {
        get { nil }
        set {}
    }
}

enum OwnedMediaStatus: Equatable {
    case connecting
    case connected
    case video(OwnedMediaVideoStatusSnapshot)
    case videoRepairing
    case videoWaitingKeyframe
    case videoDropped
    case tilesLive

    var labelText: String {
        switch self {
        case .connecting:
            "media connecting"
        case .connected:
            "media connected"
        case .video(let snapshot):
            snapshot.labelText
        case .videoRepairing:
            "video repairing"
        case .videoWaitingKeyframe:
            "video waiting keyframe"
        case .videoDropped:
            "video dropped"
        case .tilesLive:
            "tiles live"
        }
    }
}

struct OwnedMediaVideoStatusSnapshot: Equatable {
    let fps: Int
    let expectedFps: Int
    let fpsDeficit: Int
    let receivedKbps: Int
    let width: Int
    let height: Int
    let gapMs: Int
    let maxGapMs: Int
    let droppedFrames: Int
    let renderStallCount: Int
    let decodeDropCount: Int
    let repairRequestedCount: Int
    let repairExpiredCount: Int
    let presentationGapCount: Int
    let presentationSkipCount: Int
    let windowMs: Int

    var labelText: String {
        "\(fps)/\(expectedFps)fps rx\(receivedKbps)kbps \(width)x\(height) gap\(gapMs) d\(droppedFrames)"
    }

    var diagnosticsFields: [String: String] {
        [
            "fps": String(fps),
            "expectedFps": String(expectedFps),
            "fpsDeficit": String(fpsDeficit),
            "receivedKbps": String(receivedKbps),
            "width": String(width),
            "height": String(height),
            "gapMs": String(gapMs),
            "maxGapMs": String(maxGapMs),
            "droppedFrames": String(droppedFrames),
            "renderStallCount": String(renderStallCount),
            "decodeDropCount": String(decodeDropCount),
            "repairRequestedCount": String(repairRequestedCount),
            "repairExpiredCount": String(repairExpiredCount),
            "presentationGapCount": String(presentationGapCount),
            "presentationSkipCount": String(presentationSkipCount),
            "windowMs": String(windowMs)
        ]
    }
}

struct OwnedMediaVideoStatusTracker {
    private let publishIntervalNs: UInt64
    private var expectedFps: Int
    private var windowStartNs: UInt64?
    private var windowFrames = 0
    private var windowBytes = 0
    private var lastEnqueueNs: UInt64?
    private var lastGapMs = 0.0
    private var maxGapMs = 0.0
    private(set) var droppedFrames = 0
    private var renderStallCount = 0
    private var decodeDropCount = 0
    private var repairRequestedCount = 0
    private var repairExpiredCount = 0
    private var presentationGapCount = 0
    private var presentationSkipCount = 0

    init(
        publishIntervalNs: UInt64 = Config.diagnosticsMediaSummaryIntervalNs,
        expectedFps: Int = Config.ownedMediaExpectedFrameRate
    ) {
        self.publishIntervalNs = publishIntervalNs
        self.expectedFps = max(1, expectedFps)
    }

    mutating func noteDroppedFrames(_ count: Int) {
        droppedFrames += max(0, count)
    }

    mutating func setExpectedFps(_ fps: Int) {
        expectedFps = max(1, fps)
    }

    mutating func noteRenderStall(_ count: Int = 1) {
        renderStallCount += max(0, count)
    }

    mutating func noteDecodeDrop(_ count: Int = 1) {
        decodeDropCount += max(0, count)
    }

    mutating func noteRepairRequested(_ count: Int = 1) {
        repairRequestedCount += max(0, count)
    }

    mutating func noteRepairExpired(_ count: Int = 1) {
        repairExpiredCount += max(0, count)
    }

    mutating func notePresentationSkip(bytes: Int) {
        presentationSkipCount += 1
        windowBytes += max(0, bytes)
    }

    mutating func noteEnqueuedFrame(
        bytes: Int,
        width: Int,
        height: Int,
        nowNs: UInt64
    ) -> OwnedMediaVideoStatusSnapshot? {
        if let lastEnqueueNs, nowNs >= lastEnqueueNs {
            lastGapMs = Double(nowNs - lastEnqueueNs) / 1_000_000.0
            maxGapMs = max(maxGapMs, lastGapMs)
            let expectedIntervalMs = 1_000.0 / Double(expectedFps)
            if lastGapMs > expectedIntervalMs * 1.5 {
                presentationGapCount += 1
            }
        }
        lastEnqueueNs = nowNs
        if windowStartNs == nil {
            windowStartNs = nowNs
        }
        windowFrames += 1
        windowBytes += max(0, bytes)
        guard let windowStartNs, nowNs >= windowStartNs + publishIntervalNs else {
            return nil
        }
        let elapsedSeconds = Double(nowNs - windowStartNs) / 1_000_000_000.0
        let fps = Int(round(Double(windowFrames) / elapsedSeconds))
        let snapshot = OwnedMediaVideoStatusSnapshot(
            fps: fps,
            expectedFps: expectedFps,
            fpsDeficit: max(0, expectedFps - fps),
            receivedKbps: Int(round(Double(windowBytes * 8) / elapsedSeconds / 1_000.0)),
            width: width,
            height: height,
            gapMs: Int(round(lastGapMs)),
            maxGapMs: Int(round(maxGapMs)),
            droppedFrames: droppedFrames,
            renderStallCount: renderStallCount,
            decodeDropCount: decodeDropCount,
            repairRequestedCount: repairRequestedCount,
            repairExpiredCount: repairExpiredCount,
            presentationGapCount: presentationGapCount,
            presentationSkipCount: presentationSkipCount,
            windowMs: Int(round(elapsedSeconds * 1_000.0))
        )
        self.windowStartNs = nowNs
        windowFrames = 0
        windowBytes = 0
        maxGapMs = 0
        renderStallCount = 0
        decodeDropCount = 0
        repairRequestedCount = 0
        repairExpiredCount = 0
        presentationGapCount = 0
        presentationSkipCount = 0
        return snapshot
    }
}

// Render-stall watchdog for the video carrier (ADR-0027). The carrier can wedge:
// frames keep arriving but the decoder stops presenting (a delta decoded against a
// reference lost to packet drop leaves the layer failed). This decides, from the
// last frame arrival, the last successful enqueue, and the last request, whether to
// ask the host for a fresh keyframe. It fires only while frames are arriving (the
// host is sending), so a quiet host (rest, or a dead link) never triggers a keyframe
// storm. Pure so it can be driven by a test clock.
struct OwnedMediaRenderStallWatchdog {
    let activeWindowNs: UInt64
    let stallThresholdNs: UInt64
    let minRequestIntervalNs: UInt64

    static func configured(
        expectedFrameRate: Int,
        minimumStallNs: UInt64
    ) -> OwnedMediaRenderStallWatchdog {
        let frameIntervalNs = UInt64(max(1, 1_000_000_000 / max(1, expectedFrameRate)))
        let (twoFrameIntervalsNs, overflow) = frameIntervalNs.multipliedReportingOverflow(by: 2)
        let cadenceAwareStallNs = max(
            minimumStallNs,
            overflow ? UInt64.max : twoFrameIntervalsNs
        )
        return OwnedMediaRenderStallWatchdog(
            activeWindowNs: cadenceAwareStallNs,
            stallThresholdNs: cadenceAwareStallNs,
            minRequestIntervalNs: minimumStallNs
        )
    }

    func shouldRequestKeyframe(
        lastArrivalNs: UInt64?,
        lastEnqueueNs: UInt64?,
        lastRequestNs: UInt64?,
        nowNs: UInt64
    ) -> Bool {
        // Host must be actively sending: an arrival within the active window.
        guard let lastArrivalNs, nowNs <= lastArrivalNs &+ activeWindowNs else { return false }
        // And nothing has presented for the stall threshold.
        guard let lastEnqueueNs, nowNs >= lastEnqueueNs &+ stallThresholdNs else { return false }
        // Rate-limit so a sustained stall asks at most once per interval.
        if let lastRequestNs, nowNs < lastRequestNs &+ minRequestIntervalNs { return false }
        return true
    }
}

@MainActor
final class OwnedMediaVideoSink: OwnedMediaFrameSink, @unchecked Sendable {
    private struct QueuedVideoFrame {
        let envelope: OwnedMediaFrameEnvelope
        let frameBytes: Int
    }

    let view: UIView
    private let surfaceLayer = CALayer()
    // ADR-0034 crisp-repair: the always-live video floor. It sits beneath surfaceLayer and
    // stays visible; surfaceLayer composites crisp tiles over it, transparent where a
    // region is reverted to video. (Supersedes the ADR-0025 video/tiles whole-surface swap.)
    private let videoLayer = AVSampleBufferDisplayLayer()
    private lazy var videoDecoder = OwnedMediaVideoDecoder(
        layer: OwnedMediaVideoLayerEnqueuer(displayLayer: videoLayer)
    )
    // Fixed-chrome diagnostics readout is owned and placed by the controller; the sink only
    // publishes status (see onOwnedMediaStatusChange / setOwnedMediaStatus).
    var onOwnedMediaStatusChange: ((OwnedMediaStatus) -> Void)?
    private(set) var lastPublishedStatus: OwnedMediaStatus?
    private let logger = Logger(subsystem: Config.logSubsystem, category: "owned-media")
    private var compositor = OwnedSurfaceCompositor()
    private var lastRenderUptimeNs: UInt64?
    private var pendingGraphicsResetRequest: OwnedGraphicsResetRequest?
    // ADR-0027 render-stall watchdog state. lastVideoArrivalUptimeNs is set on every
    // video frame that reaches the sink (the host is sending); lastVideoEnqueueUptimeNs
    // only when the decoder layer accepts a displayed or dependency-only sample. The
    // watchdog asks for a keyframe when arrivals are fresh but decoding makes no
    // progress for the cadence-aware stall window, rate-limited by
    // lastKeyframeRequestUptimeNs.
    private var lastVideoArrivalUptimeNs: UInt64?
    private var lastVideoEnqueueUptimeNs: UInt64?
    private var lastKeyframeRequestUptimeNs: UInt64?
    private var videoStatusTracker = OwnedMediaVideoStatusTracker()
    private var videoPresentationPacer = OwnedMediaLatestFramePacer<QueuedVideoFrame>(
        expectedFrameRate: Config.ownedMediaExpectedFrameRate
    )
    private var pendingVideoPresentationTask: Task<Void, Never>?
    private var videoKeyframeRequestHandler: (@Sendable () -> Void)?
    // ADR-0088: reports each decoded-but-never-shown frame's size to the transport, which
    // accumulates it into the link-health window.
    private var presentationSkipHandler: (@Sendable (Int) -> Void)?
    private var ltrAcknowledgementHandler: (@Sendable (UInt64) -> Void)?
    private var stallWatchdog: OwnedMediaRenderStallWatchdog
    private let stallTimer: DispatchSourceTimer

    init() {
        let stallNs = UInt64(Config.ownedMediaRenderStallMs) * 1_000_000
        stallWatchdog = OwnedMediaRenderStallWatchdog.configured(
            expectedFrameRate: Config.ownedMediaExpectedFrameRate,
            minimumStallNs: stallNs
        )
        stallTimer = DispatchSource.makeTimerSource(queue: .main)
        let container = LayerBackedVideoContainerView()
        container.backgroundColor = .black
        view = container
        // ADR-0034 crisp-repair: the video layer is the always-live floor; the surface
        // layer composites crisp tiles over it, transparent where a region is on video.
        // Add the video layer first so the surface layer sits above it, and give the
        // surface layer a clear background so its transparent (reverted) regions reveal the
        // video beneath. Both share resizeAspect against the same bounds, so a tile at
        // (x, y) lines up with the same point of the video floor.
        videoLayer.videoGravity = .resizeAspect
        videoLayer.backgroundColor = UIColor.black.cgColor
        videoLayer.isHidden = true
        container.layer.addSublayer(videoLayer)
        surfaceLayer.contentsGravity = .resizeAspect
        surfaceLayer.backgroundColor = UIColor.clear.cgColor
        surfaceLayer.isOpaque = false
        surfaceLayer.isHidden = true
        container.layer.addSublayer(surfaceLayer)
        container.layoutHandler = { [weak self, weak container] in
            guard let self, let bounds = container?.bounds else { return }
            self.surfaceLayer.frame = bounds
            self.videoLayer.frame = bounds
        }
        // Poll for a render stall at a fraction of the stall window so detection
        // latency stays bounded. The check is cheap (a few timestamp compares) and a
        // quiet host makes it a no-op.
        let pollSeconds = max(0.25, Double(Config.ownedMediaRenderStallMs) / 1000.0 / 2.0)
        stallTimer.schedule(deadline: .now() + pollSeconds, repeating: pollSeconds)
        stallTimer.setEventHandler { [weak self] in
            Task { @MainActor in self?.checkRenderStall() }
        }
        stallTimer.resume()
    }

    deinit {
        pendingVideoPresentationTask?.cancel()
        stallTimer.cancel()
    }

    func setVideoKeyframeRequestHandler(_ handler: @escaping @Sendable () -> Void) {
        videoKeyframeRequestHandler = handler
    }

    func setOwnedMediaPresentationSkipHandler(_ handler: @escaping @Sendable (Int) -> Void) {
        presentationSkipHandler = handler
    }

    func setLtrAcknowledgementHandler(_ handler: @escaping @Sendable (UInt64) -> Void) {
        ltrAcknowledgementHandler = handler
    }

    // Timer-driven: ask the host for a keyframe if the carrier has wedged (frames
    // arriving, nothing presenting). Keeps the last frame up via the decoder reset and
    // requires a keyframe to resync. ADR-0027.
    private func checkRenderStall() {
        let now = DispatchTime.now().uptimeNanoseconds
        guard stallWatchdog.shouldRequestKeyframe(
            lastArrivalNs: lastVideoArrivalUptimeNs,
            lastEnqueueNs: lastVideoEnqueueUptimeNs,
            lastRequestNs: lastKeyframeRequestUptimeNs,
            nowNs: now
        ) else { return }
        logger.notice("owned media video render-stall keyframe-request enqueueAgeMs=\(self.ageMs(self.lastVideoEnqueueUptimeNs, now), privacy: .public) arrivalAgeMs=\(self.ageMs(self.lastVideoArrivalUptimeNs, now), privacy: .public)")
        ownedMediaStderrTrace("video-render-stall-keyframe-request enqueueAgeMs=\(ageMs(lastVideoEnqueueUptimeNs, now)) arrivalAgeMs=\(ageMs(lastVideoArrivalUptimeNs, now))")
        videoStatusTracker.noteRenderStall()
        ClientDiagnostics.shared.record(
            type: "videoRenderStall",
            fields: [
                "enqueueAgeMs": String(Int(ageMs(lastVideoEnqueueUptimeNs, now))),
                "arrivalAgeMs": String(Int(ageMs(lastVideoArrivalUptimeNs, now)))
            ],
            level: .error
        )
        requestKeyframe(now: now)
        videoDecoder.reset()
        videoPresentationPacer.reset()
        pendingVideoPresentationTask?.cancel()
        pendingVideoPresentationTask = nil
    }

    /// Adopt a new transport's stream, keeping the frame that is already displayed.
    ///
    /// Deliberately does not touch `videoLayer`: no `flush()`, no `flushAndRemoveImage()`. The
    /// layer holds the last decoded picture, and that picture is the entire point -- it stays
    /// up, frozen, while the replacement session dials, instead of the user watching black.
    /// The new stream begins with a keyframe (a fresh host encoder has no references to encode
    /// against), so nothing here needs to survive for correctness.
    func prepareForStreamHandover() {
        logger.notice("owned media video stream-handover keeping last frame")
        videoDecoder.reset()
        videoPresentationPacer.reset()
        pendingVideoPresentationTask?.cancel()
        pendingVideoPresentationTask = nil
        lastVideoArrivalUptimeNs = nil
        lastVideoEnqueueUptimeNs = nil
        lastKeyframeRequestUptimeNs = nil
    }

    // Single rate-limited keyframe-request point shared by the watchdog and the
    // wedged-layer recovery in renderOwnedVideoFrame.
    private func requestKeyframe(now: UInt64) {
        if let last = lastKeyframeRequestUptimeNs,
           now < last &+ UInt64(Config.ownedMediaRenderStallMs) * 1_000_000 {
            return
        }
        lastKeyframeRequestUptimeNs = now
        ClientDiagnostics.shared.record(type: "videoKeyframeRequested", fields: [:], level: .default)
        videoKeyframeRequestHandler?()
    }

    private func ageMs(_ thenNs: UInt64?, _ nowNs: UInt64) -> Double {
        guard let thenNs, nowNs >= thenNs else { return -1 }
        return Double(nowNs - thenNs) / 1_000_000.0
    }

    // ADR-0073: accept complete HEVC frames without building a presentation backlog.
    // One newest frame may wait for the next fixed-rate slot. A replaced frame is
    // decoded with DoNotDisplay so later deltas retain their reference chain.
    func renderOwnedVideoFrame(_ envelope: OwnedMediaFrameEnvelope, frameBytes: Int) {
        let now = DispatchTime.now().uptimeNanoseconds
        lastVideoArrivalUptimeNs = now
        let actions = videoPresentationPacer.submit(
            QueuedVideoFrame(envelope: envelope, frameBytes: frameBytes),
            nowNs: now
        )
        for action in actions {
            processVideoPresentationAction(action, nowNs: now)
        }
        schedulePendingVideoPresentation(nowNs: now)
        showVideoFloor()
        lastRenderUptimeNs = now
    }

    private func processVideoPresentationAction(
        _ action: OwnedMediaVideoPresentationAction<QueuedVideoFrame>,
        nowNs: UInt64
    ) {
        let frame: QueuedVideoFrame
        let presentation: OwnedMediaVideoPresentation
        switch action {
        case .decodeOnly(let queuedFrame):
            frame = queuedFrame
            presentation = .decodeOnly
        case .display(let queuedFrame):
            frame = queuedFrame
            presentation = .display
        }

        let envelope = frame.envelope
        let result = videoDecoder.decodeAndEnqueue(envelope, presentation: presentation)
        switch result {
        case .enqueued:
            ClientRuntimeTelemetry.shared.advanceVideoMilestone(.decoderEnqueued)
            lastVideoEnqueueUptimeNs = nowNs
            // ADR-0090: tell the host it may reference this frame later instead of sending a
            // keyframe to resync. Acknowledged on enqueue, which is the strongest signal
            // available -- the display layer decodes asynchronously and reports no per-sample
            // success. If it does fail later, the existing decode-failure paths request a
            // keyframe, so an over-eager acknowledgement costs a round trip rather than
            // stranding the client on a frame it cannot decode.
            if let token = envelope.header.ltrToken {
                ltrAcknowledgementHandler?(token)
            }
            switch presentation {
            case .display:
                ClientRuntimeTelemetry.shared.advanceVideoMilestone(.presentationAttempted)
                if let snapshot = videoStatusTracker.noteEnqueuedFrame(
                    bytes: frame.frameBytes,
                    width: envelope.header.width,
                    height: envelope.header.height,
                    nowNs: nowNs
                ) {
                    setOwnedMediaStatus(.video(snapshot))
                    ClientDiagnostics.shared.record(
                        type: "mediaSummary",
                        fields: snapshot.diagnosticsFields,
                        level: .info
                    )
                    ClientDiagnostics.shared.record(
                        type: "mediaPresentationWindow",
                        fields: snapshot.diagnosticsFields,
                        level: .info
                    )
                }
            case .decodeOnly:
                videoStatusTracker.notePresentationSkip(bytes: frame.frameBytes)
                presentationSkipHandler?(frame.frameBytes)
                ClientDiagnostics.shared.record(
                    type: "mediaStalePresentationSkipped",
                    fields: ["frameId": String(envelope.header.frameId)],
                    level: .info
                )
            }
        case .recoveredRequestKeyframe, .droppedMismatchedDimensionsRequestKeyframe:
            // The decoder reached a state that only a keyframe can resync: either a
            // wedged layer or a resolution-change delta without a matching keyframe.
            ownedMediaStderrTrace("video-frame-recovered frame=\(envelope.header.frameId)")
            videoStatusTracker.noteDroppedFrames(1)
            videoStatusTracker.noteDecodeDrop()
            setOwnedMediaStatus(.videoRepairing)
            ClientDiagnostics.shared.record(
                type: "videoDecoderRecovered",
                fields: ["frameId": String(envelope.header.frameId)],
                level: .error
            )
            requestKeyframe(now: nowNs)
        case .droppedPendingKeyframe:
            videoStatusTracker.noteDroppedFrames(1)
            videoStatusTracker.noteDecodeDrop()
            setOwnedMediaStatus(.videoWaitingKeyframe)
            ownedMediaStderrTrace("video-frame-dropped frame=\(envelope.header.frameId) reason=\(result)")
            ClientDiagnostics.shared.record(
                type: "videoFrameDropped",
                fields: [
                    "frameId": String(envelope.header.frameId),
                    "reason": String(describing: result)
                ],
                level: .error
            )
        case .formatDescriptionUnavailable, .sampleBufferBuildFailed:
            videoStatusTracker.noteDroppedFrames(1)
            videoStatusTracker.noteDecodeDrop()
            setOwnedMediaStatus(.videoDropped)
            ownedMediaStderrTrace("video-frame-dropped frame=\(envelope.header.frameId) reason=\(result)")
            ClientDiagnostics.shared.record(
                type: "videoFrameDropped",
                fields: [
                    "frameId": String(envelope.header.frameId),
                    "reason": String(describing: result)
                ],
                level: .error
            )
        }
    }

    private func schedulePendingVideoPresentation(nowNs: UInt64) {
        pendingVideoPresentationTask?.cancel()
        guard let deadlineNs = videoPresentationPacer.nextPresentationDeadlineNs else {
            pendingVideoPresentationTask = nil
            return
        }
        let delayNs = deadlineNs > nowNs ? deadlineNs - nowNs : 0
        pendingVideoPresentationTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: delayNs)
            } catch is CancellationError {
                return
            } catch {
                assertionFailure("unexpected video presentation timer error: \(error)")
                return
            }
            guard let self else { return }
            self.pendingVideoPresentationTask = nil
            let presentationNowNs = DispatchTime.now().uptimeNanoseconds
            if let action = self.videoPresentationPacer.takePendingIfDue(nowNs: presentationNowNs) {
                self.processVideoPresentationAction(action, nowNs: presentationNowNs)
            }
            self.schedulePendingVideoPresentation(nowNs: presentationNowNs)
        }
    }

    // ADR-0034 crisp-repair: the video floor and the crisp overlay composite together;
    // there is no whole-surface swap (this retires the ADR-0025 .video/.tiles swap). The
    // floor is revealed once video frames arrive; the overlay once a crisp frame applies.
    private func showVideoFloor() {
        if videoLayer.isHidden { videoLayer.isHidden = false }
    }

    private func showCrispOverlay() {
        if surfaceLayer.isHidden { surfaceLayer.isHidden = false }
    }

    /// Test hook: the most recently composited surface image, used to assert a
    /// graphics envelope rendered to a non-nil surface without driving UIKit.
    func debugCurrentImage() -> CGImage? {
        compositor.makeImage()
    }

    func renderOwnedGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        queueDepth: OwnedGraphicsQueueDepth = .empty
    ) -> OwnedGraphicsFrameAck {
        do {
            ownedMediaStderrTrace("graphics-frame-apply-start frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(compositor.totalGraphicsFramesApplied)")
            let stats = try compositor.applyGraphicsFrame(envelope)
            let makeImageStartNs = DispatchTime.now().uptimeNanoseconds
            surfaceLayer.contents = compositor.makeImage()
            let makeImageMs = OwnedMediaRenderTiming.elapsedMs(
                from: makeImageStartNs,
                to: DispatchTime.now().uptimeNanoseconds
            )
            // ADR-0034 crisp-repair: a graphics frame sharpens settled regions over the
            // live video floor. Reveal the crisp overlay (transparent where reverted, so
            // the video shows through) and leave the video floor visible beneath it.
            showCrispOverlay()
            setOwnedMediaStatus(.tilesLive)
            // A graphics (tile) frame is the only thing that refreshes
            // surfaceLayer now, so every applied frame is a screen update. Stamp
            // the render clock here so renderGapMs reflects real frame spacing.
            lastRenderUptimeNs = DispatchTime.now().uptimeNanoseconds
            ownedMediaStderrTrace("graphics-frame frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) commands=\(envelope.commands.count) bytes=\(envelope.payload.count) action=\(stats.action) compositorMs=\(Self.formatDouble(stats.compositorMs)) tileDecodeMs=\(Self.formatDouble(stats.tileDecodeMs)) tilePaintMs=\(Self.formatDouble(stats.tilePaintMs)) makeImageMs=\(Self.formatDouble(makeImageMs)) stale=\(stats.staleDiscardCount) tileBytes=\(stats.tileBytes) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(stats.totalGraphicsFramesApplied)")
            return OwnedGraphicsFrameAck(
                surfaceGeneration: envelope.header.surfaceGeneration,
                frameId: envelope.header.frameId,
                compositorMs: stats.compositorMs,
                queueDepthBytes: queueDepth.queueDepthBytes,
                queuedFrames: queueDepth.queuedFrames,
                totalGraphicsFramesApplied: stats.totalGraphicsFramesApplied,
                staleDiscardCount: stats.staleDiscardCount
            )
        } catch {
            ownedMediaStderrTrace("graphics-frame-failed frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(compositor.totalGraphicsFramesApplied) error=\(String(describing: error))")
            pendingGraphicsResetRequest = currentGraphicsResetRequest(reason: "graphics-frame-\(String(describing: error))")
            return OwnedGraphicsFrameAck(
                surfaceGeneration: compositor.committedUpdateId.surfaceGeneration,
                frameId: compositor.committedUpdateId.frameId,
                compositorMs: 0,
                queueDepthBytes: queueDepth.queueDepthBytes,
                queuedFrames: queueDepth.queuedFrames,
                totalGraphicsFramesApplied: compositor.totalGraphicsFramesApplied,
                staleDiscardCount: compositor.staleDiscardCount
            )
        }
    }

    func currentGraphicsResetRequest(reason: String) -> OwnedGraphicsResetRequest {
        let committed = compositor.committedUpdateId
        return OwnedGraphicsResetRequest(
            reason: reason,
            lastCommittedSurfaceGeneration: committed.surfaceGeneration,
            lastCommittedFrameId: committed.frameId
        )
    }

    func consumePendingGraphicsResetRequest() -> OwnedGraphicsResetRequest? {
        let request = pendingGraphicsResetRequest
        pendingGraphicsResetRequest = nil
        return request
    }

    func noteOwnedMediaDroppedFrames(_ count: Int) {
        videoStatusTracker.noteDroppedFrames(count)
    }

    func noteOwnedMediaRepairRequested(_ count: Int) {
        videoStatusTracker.noteRepairRequested(count)
    }

    func noteOwnedMediaRepairExpired(_ count: Int) {
        videoStatusTracker.noteRepairExpired(count)
    }

    func setOwnedMediaExpectedFrameRate(_ fps: Int) {
        videoStatusTracker.setExpectedFps(fps)
        videoPresentationPacer.setExpectedFrameRate(fps)
        stallWatchdog = OwnedMediaRenderStallWatchdog.configured(
            expectedFrameRate: fps,
            minimumStallNs: UInt64(Config.ownedMediaRenderStallMs) * 1_000_000
        )
        schedulePendingVideoPresentation(nowNs: DispatchTime.now().uptimeNanoseconds)
    }

    func setOwnedMediaStatus(_ status: OwnedMediaStatus) {
        guard lastPublishedStatus != status else { return }
        lastPublishedStatus = status
        onOwnedMediaStatusChange?(status)
    }

    func lastPublishedStatusTextForTesting() -> String? {
        lastPublishedStatus?.labelText
    }

    /// Test hooks for the crisp-repair compositing model: the video floor and the crisp
    /// overlay are revealed independently and composite together (no whole-surface swap).
    func videoFloorVisibleForTesting() -> Bool { !videoLayer.isHidden }
    func crispOverlayVisibleForTesting() -> Bool { !surfaceLayer.isHidden }
}

private func ownedMediaStderrTrace(_ message: String) {
    guard ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_STDERR_TRACE"] == "1",
          let data = "[owned-media] \(message)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}

private extension OwnedMediaVideoSink {
    static func formatDouble(_ value: Double) -> String {
        String(format: "%.1f", value)
    }
}

struct OwnedSurfaceCompositorStats: Equatable {
    let action: String
    let compositorMs: Double
    let tileDecodeMs: Double
    let tilePaintMs: Double
    let staleDiscardCount: Int
    let totalGraphicsFramesApplied: UInt64
    let tileBytes: Int
}

private struct OwnedSurfaceCompositorTiming {
    var tileDecodeMs = 0.0
    var tilePaintMs = 0.0
}

private enum OwnedSurfaceValidatedCommand {
    case resetSurface(surfaceGeneration: UInt32, width: Int, height: Int, baseline: OwnedSurfaceUpdateId)
    case bitmapTile(x: Int, y: Int, width: Int, height: Int, decoded: Data)
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, decoded: Data)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)
    // ADR-0034 crisp-repair: clear a region to transparent so the live video floor
    // shows through it. The data op is the same regardless of how the surface layer
    // is composited; per-region compositing over video lands in a later task.
    case revertTileToVideo(x: Int, y: Int, width: Int, height: Int)
}

private enum OwnedSurfaceCompositorValidationError: Error {
    case staleReset
}

struct OwnedSurfaceCompositor {
    private(set) var committedUpdateId = OwnedSurfaceUpdateId(surfaceGeneration: 0, frameId: 0)
    private(set) var staleDiscardCount = 0
    private(set) var totalGraphicsFramesApplied: UInt64 = 0
    private var width = 0
    private var height = 0
    private var bytesPerRow = 0
    private var pixels = Data()
    private var slotBitmaps: [UInt16: (width: Int, height: Int, pixels: Data)] = [:]

    mutating func applyGraphicsFrame(_ envelope: OwnedGraphicsFrameEnvelope) throws -> OwnedSurfaceCompositorStats {
        let startNs = DispatchTime.now().uptimeNanoseconds
        let updateId = envelope.header.updateId
        guard updateId.isStrictlyNewer(than: committedUpdateId) ||
            envelope.commands.contains(where: { command in
                if case .resetSurface = command { return true }
                return false
        }) else {
            staleDiscardCount += 1
            return stats(action: "stale-graphics", startNs: startNs, timing: .init(), tileBytes: 0)
        }
        var timing = OwnedSurfaceCompositorTiming()
        let validatedCommands: [OwnedSurfaceValidatedCommand]
        do {
            validatedCommands = try validateGraphicsFrame(envelope, updateId: updateId, timing: &timing)
        } catch OwnedSurfaceCompositorValidationError.staleReset {
            staleDiscardCount += 1
            return stats(action: "stale-reset", startNs: startNs, timing: timing, tileBytes: 0)
        }
        var tileBytes = 0
        for command in validatedCommands {
            switch command {
            case let .resetSurface(_, width, height, baseline):
                // Black-flash fix (ADR-0022): a reset only bumps the generation and
                // clears the content cache; the reset's own stripes (or the next
                // periodic heal) repaint the whole surface. When the dimensions are
                // unchanged (the common case: a coherence reset, not a resize), keep
                // the last-good pixels visible so the surface shows a slightly-stale
                // frame instead of flashing black until the repaint arrives. Only a
                // genuine resize (rare) reallocates and clears to black.
                let dimsUnchanged = width == self.width && height == self.height && pixels.count == width * 4 * height
                self.width = width
                self.height = height
                bytesPerRow = width * 4
                if !dimsUnchanged {
                    pixels = Data(count: bytesPerRow * height)
                }
                slotBitmaps.removeAll()
                committedUpdateId = baseline
            case let .bitmapTile(x, y, width, height, decoded):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(decoded, x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                tileBytes += decoded.count
            case let .cacheTile(slot, x, y, width, height, decoded):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(decoded, x: x, y: y, width: width, height: height)
                slotBitmaps[slot] = (width, height, decoded)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                tileBytes += decoded.count
            case let .drawCachedTile(slot, x, y, width, height):
                // Black-flash fix part B (ADR-0022): a missing or mismatched slot is
                // non-fatal. The host references slots it believes the client holds,
                // but a dropped earlier frame can leave a gap. Rejecting forced a
                // generation reset, which (before part A) flashed black. Instead skip
                // the tile, leave the current pixels, and let the next periodic heal
                // (which re-sends the whole surface) repaint it. Decode and stale-order
                // guards stay fatal; only the cache miss is tolerated.
                guard let cached = slotBitmaps[slot], cached.width == width, cached.height == height else {
                    // Coherence invariant (ADR-0034): the host believes this slot is cached,
                    // but we do not hold it (host/client slot divergence). Leaving the current
                    // pixels could show stale crisp from a prior desktop, so revert the region
                    // to the live video floor instead — stale-crisp must be impossible. The
                    // host re-caches the tile on its next content change.
                    ownedMediaStderrTrace("drawCachedTile-skip slot=\(slot) x=\(x) y=\(y) reason=missing-or-mismatched-slot")
                    try clearRect(x: x, y: y, width: width, height: height)
                    continue
                }
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(cached.pixels, x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
            case let .revertTileToVideo(x, y, width, height):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try clearRect(x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
            }
        }
        if updateId.isStrictlyNewer(than: committedUpdateId) {
            committedUpdateId = updateId
        }
        totalGraphicsFramesApplied += 1
        return stats(action: "graphics", startNs: startNs, timing: timing, tileBytes: tileBytes)
    }

    func makeImage() -> CGImage? {
        guard width > 0, height > 0, pixels.count == bytesPerRow * height else { return nil }
        let presentationPixels = pixels.withUnsafeBytes { bytes in
            Data(bytes)
        }
        let data = presentationPixels as CFData
        guard let provider = CGDataProvider(data: data),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue)
                .union(.byteOrder32Little),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    private func stats(
        action: String,
        startNs: UInt64,
        timing: OwnedSurfaceCompositorTiming,
        tileBytes: Int
    ) -> OwnedSurfaceCompositorStats {
        OwnedSurfaceCompositorStats(
            action: action,
            compositorMs: Double(DispatchTime.now().uptimeNanoseconds &- startNs) / 1_000_000.0,
            tileDecodeMs: timing.tileDecodeMs,
            tilePaintMs: timing.tilePaintMs,
            staleDiscardCount: staleDiscardCount,
            totalGraphicsFramesApplied: totalGraphicsFramesApplied,
            tileBytes: tileBytes
        )
    }

    func pixelBytesForDiagnostics() -> Data {
        pixels
    }

    private func validateGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        updateId: OwnedSurfaceUpdateId,
        timing: inout OwnedSurfaceCompositorTiming
    ) throws -> [OwnedSurfaceValidatedCommand] {
        var candidateCommittedUpdateId = committedUpdateId
        var candidateWidth = width
        var candidateHeight = height
        var candidateBytesPerRow = bytesPerRow
        var candidatePixelCount = pixels.count
        var validated: [OwnedSurfaceValidatedCommand] = []
        validated.reserveCapacity(envelope.commands.count)

        for command in envelope.commands {
            switch command {
            case let .resetSurface(surfaceGeneration, width, height, pixelFormat):
                guard pixelFormat == .bgra else {
                    throw SessionRejected(reason: .malformed)
                }
                guard let baseline = OwnedSurfaceUpdateId.acceptedResetBaseline(
                        surfaceGeneration: surfaceGeneration,
                        committedSurfaceGeneration: candidateCommittedUpdateId.surfaceGeneration
                ) else {
                    throw OwnedSurfaceCompositorValidationError.staleReset
                }
                candidateWidth = width
                candidateHeight = height
                candidateBytesPerRow = width * 4
                candidatePixelCount = candidateBytesPerRow * height
                candidateCommittedUpdateId = baseline
                validated.append(.resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: width,
                    height: height,
                    baseline: baseline
                ))
            case let .bitmapTile(x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId),
                      compression == .lzfse || compression == .jpeg else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                let end = byteRange.offset + byteRange.length
                guard byteRange.offset >= 0,
                      byteRange.length > 0,
                      end <= envelope.payload.count else {
                    throw SessionRejected(reason: .malformed)
                }
                let decodeStartNs = DispatchTime.now().uptimeNanoseconds
                let compressed = envelope.payload[byteRange.offset..<end]
                // The fullframe fallback arrives as one lossy JPEG; small tiles
                // stay lossless LZFSE. Both decode to width*height*4 BGRA so the
                // compositor paints them identically.
                let decoded: Data
                switch compression {
                case .lzfse:
                    decoded = try decompressLZFSE(Data(compressed), expectedCount: width * height * 4)
                case .jpeg:
                    decoded = try Self.decodeJPEG(Data(compressed), width: width, height: height)
                }
                timing.tileDecodeMs += OwnedMediaRenderTiming.elapsedMs(
                    from: decodeStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                validated.append(.bitmapTile(x: x, y: y, width: width, height: height, decoded: decoded))
            case let .cacheTile(slot, x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId),
                      compression == .lzfse || compression == .jpeg else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                let cacheEnd = byteRange.offset + byteRange.length
                guard byteRange.offset >= 0,
                      byteRange.length > 0,
                      cacheEnd <= envelope.payload.count else {
                    throw SessionRejected(reason: .malformed)
                }
                let cacheDecodeStartNs = DispatchTime.now().uptimeNanoseconds
                let cacheCompressed = Data(envelope.payload[byteRange.offset..<cacheEnd])
                let cacheDecoded: Data
                switch compression {
                case .lzfse:
                    cacheDecoded = try decompressLZFSE(cacheCompressed, expectedCount: width * height * 4)
                case .jpeg:
                    cacheDecoded = try Self.decodeJPEG(cacheCompressed, width: width, height: height)
                }
                timing.tileDecodeMs += OwnedMediaRenderTiming.elapsedMs(
                    from: cacheDecodeStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                validated.append(.cacheTile(slot: slot, x: x, y: y, width: width, height: height, decoded: cacheDecoded))
            case let .drawCachedTile(slot, x, y, width, height):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId) else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                validated.append(.drawCachedTile(slot: slot, x: x, y: y, width: width, height: height))
            case let .revertTileToVideo(x, y, width, height):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId) else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                validated.append(.revertTileToVideo(x: x, y: y, width: width, height: height))
            }
        }
        return validated
    }

    private func validateRect(x: Int, y: Int, width: Int, height: Int) throws {
        try Self.validateRect(
            x: x,
            y: y,
            width: width,
            height: height,
            surfaceWidth: self.width,
            surfaceHeight: self.height,
            bytesPerRow: bytesPerRow,
            pixelCount: pixels.count
        )
    }

    private static func validateRect(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        surfaceWidth: Int,
        surfaceHeight: Int,
        bytesPerRow: Int,
        pixelCount: Int
    ) throws {
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= surfaceWidth - width,
              y <= surfaceHeight - height,
              pixelCount == bytesPerRow * surfaceHeight else {
            throw SessionRejected(reason: .malformed)
        }
    }

    // ADR-0034 crisp-repair: zero a region to transparent BGRA (0,0,0,0) so the live
    // video floor shows through it once the surface layer composites over the video.
    private mutating func clearRect(x: Int, y: Int, width: Int, height: Int) throws {
        try validateRect(x: x, y: y, width: width, height: height)
        let rowBytes = width * 4
        pixels.withUnsafeMutableBytes { targetBytes in
            guard let targetBase = targetBytes.baseAddress else { return }
            for row in 0..<height {
                memset(targetBase.advanced(by: (y + row) * bytesPerRow + x * 4), 0, rowBytes)
            }
        }
    }

    private mutating func paintTile(_ tile: Data, x: Int, y: Int, width: Int, height: Int) throws {
        try validateRect(x: x, y: y, width: width, height: height)
        guard tile.count == width * height * 4 else {
            throw SessionRejected(reason: .malformed)
        }
        let tileBytesPerRow = width * 4
        pixels.withUnsafeMutableBytes { targetBytes in
            tile.withUnsafeBytes { sourceBytes in
                guard let targetBase = targetBytes.baseAddress,
                      let sourceBase = sourceBytes.baseAddress else { return }
                for row in 0..<height {
                    let source = sourceBase.advanced(by: row * tileBytesPerRow)
                    let target = targetBase.advanced(by: (y + row) * bytesPerRow + x * 4)
                    target.copyMemory(from: source, byteCount: tileBytesPerRow)
                }
            }
        }
    }

    // Decode the fullframe JPEG fallback back to width*height*4 BGRA so the
    // compositor paints it like an LZFSE tile. CoreGraphics is symmetric with the
    // host CGImage encoder: both use the top-down row-0-is-top convention, so the
    // decoded buffer aligns with the surface without a vertical flip.
    private static func decodeJPEG(_ data: Data, width: Int, height: Int) throws -> Data {
        // The host may encode the fullframe JPEG smaller than the destination tile
        // (congestion downscale), so accept any source no larger than the tile and
        // let the context scale it up to fill. A larger-than-destination image is
        // malformed (the host never upsizes). LZFSE tiles still decode at exact dims.
        guard width > 0, height > 0,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width > 0, image.height > 0,
              image.width <= width, image.height <= height else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        // Write an opaque alpha (premultipliedFirst over the fully-covered rect yields
        // alpha 0xFF) to match makeImage's premultipliedFirst surface. A noneSkip* format
        // would leave the alpha byte 0, which now (surfaceLayer composites with alpha
        // authoritative, ADR-0034) renders the whole tile transparent instead of opaque.
        let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        let drew = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress,
                  let context = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: bitmapInfo
                  ) else { return false }
            // Smooth the upscale of a downscaled fullframe; a no-op when dims match.
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drew else { throw SessionRejected(reason: .malformed) }
        return pixels
    }

    private func decompressLZFSE(_ data: Data, expectedCount: Int) throws -> Data {
        guard !data.isEmpty, expectedCount > 0 else {
            throw SessionRejected(reason: .malformed)
        }
        var output = Data(count: expectedCount)
        let decodedCount = output.withUnsafeMutableBytes { outputBytes in
            data.withUnsafeBytes { inputBytes in
                compression_decode_buffer(
                    outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    expectedCount,
                    inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    data.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }
        guard decodedCount == expectedCount else {
            throw SessionRejected(reason: .malformed)
        }
        return output
    }
}

private final class LayerBackedVideoContainerView: UIView {
    var layoutHandler: (() -> Void)?

    override class var layerClass: AnyClass {
        CALayer.self
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutHandler?()
    }
}
