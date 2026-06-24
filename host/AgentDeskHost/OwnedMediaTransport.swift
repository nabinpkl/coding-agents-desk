import CoreMedia
import CoreVideo
import CryptoKit
import Compression
import CoreImage
import Foundation
import Network
import Security
import VideoToolbox
import os

typealias OwnedMediaDatagramAuthorizer = @Sendable (MediaChannelHello) async -> MediaCapabilityValidationResult
typealias OwnedGraphicsChannelAuthorizer = @Sendable (GraphicsChannelHello) async -> MediaCapabilityValidationResult

final class OwnedGraphicsChannelServer: @unchecked Sendable {
    let connection: NWConnection
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-graphics")
    private let stateQueue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-graphics-state")
    private var closed = false
    private var latestAck: OwnedGraphicsFrameAck?
    private var controlParser = OwnedGraphicsControlStreamFrameParser()
    private let onFrameAck: @Sendable (ObjectIdentifier, OwnedGraphicsFrameAck) -> Void
    private let onResetRequest: @Sendable (OwnedGraphicsResetRequest) -> Void

    init(
        connection: NWConnection,
        onFrameAck: @escaping @Sendable (ObjectIdentifier, OwnedGraphicsFrameAck) -> Void,
        onResetRequest: @escaping @Sendable (OwnedGraphicsResetRequest) -> Void
    ) {
        self.connection = connection
        self.onFrameAck = onFrameAck
        self.onResetRequest = onResetRequest
        receiveControl()
    }

    func send(_ envelope: OwnedGraphicsFrameEnvelope) async throws -> Int {
        guard !isClosed else {
            throw SessionRejected(reason: .unauthorized)
        }
        let data = try envelope.encode()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
        logger.notice("owned graphics sent frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) commands=\(envelope.commands.count, privacy: .public) bytes=\(data.count, privacy: .public)")
        return data.count
    }

    func close() {
        stateQueue.sync {
            closed = true
        }
        connection.cancel()
    }

    var isOpen: Bool {
        !isClosed
    }

    private var isClosed: Bool {
        stateQueue.sync { closed }
    }

    private func receiveControl() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, error in
            guard let self else { return }
            if let error {
                self.logger.error("owned graphics control receive failed: \(String(describing: error), privacy: .public)")
                self.close()
                return
            }
            guard !self.isClosed else { return }
            if let data, !data.isEmpty {
                self.handleControlChunk(data)
            }
            self.receiveControl()
        }
    }

    private func handleControlChunk(_ data: Data) {
        do {
            let frames = try stateQueue.sync {
                try controlParser.append(data)
            }
            for frame in frames {
                handleControlData(frame)
            }
        } catch {
            logger.error("owned graphics malformed control stream bytes=\(data.count, privacy: .public) error=\(String(describing: error), privacy: .public)")
            close()
        }
    }

    private func handleControlData(_ data: Data) {
        if let ack = try? JSONDecoder().decode(OwnedGraphicsFrameAck.self, from: data),
           ack.type == "graphics-frame-ack" {
            stateQueue.sync {
                latestAck = ack
            }
            onFrameAck(ObjectIdentifier(connection), ack)
            logger.notice("owned graphics ack frame=\(ack.frameId, privacy: .public) generation=\(ack.surfaceGeneration, privacy: .public) compositorMs=\(ack.compositorMs, privacy: .public) queuedFrames=\(ack.queuedFrames, privacy: .public) queueBytes=\(ack.queueDepthBytes, privacy: .public) totalApplied=\(ack.totalGraphicsFramesApplied, privacy: .public) stale=\(ack.staleDiscardCount, privacy: .public)")
            return
        }
        if let request = try? JSONDecoder().decode(OwnedGraphicsResetRequest.self, from: data),
           request.type == "graphics-reset-request" {
            logger.error("owned graphics reset-request reason=\(request.reason, privacy: .public) generation=\(request.lastCommittedSurfaceGeneration, privacy: .public) frame=\(request.lastCommittedFrameId, privacy: .public)")
            onResetRequest(request)
            return
        }
        logger.error("owned graphics malformed control bytes=\(data.count, privacy: .public)")
    }
}

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let codec: OwnedMediaCodec
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer
    private let graphicsAuthorizer: OwnedGraphicsChannelAuthorizer
    private let scrollActivityHintProvider: @Sendable () -> ScrollActivityHint?
    private let scrollRegionHintProvider: @Sendable () -> ScrollRegionFocusHint?

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer,
        graphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer,
        scrollActivityHintProvider: @escaping @Sendable () -> ScrollActivityHint? = { nil },
        scrollRegionHintProvider: @escaping @Sendable () -> ScrollRegionFocusHint? = { nil }
    ) {
        self.codec = codec
        self.configuration = configuration
        self.authorizer = authorizer
        self.graphicsAuthorizer = graphicsAuthorizer
        self.scrollActivityHintProvider = scrollActivityHintProvider
        self.scrollRegionHintProvider = scrollRegionHintProvider
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            codec: codec,
            configuration: configuration,
            authorizer: authorizer,
            graphicsAuthorizer: graphicsAuthorizer,
            scrollActivityHintProvider: scrollActivityHintProvider,
            scrollRegionHintProvider: scrollRegionHintProvider
        )
    }
}

struct OwnedMediaEncodingConfiguration: Equatable, Sendable {
    let expectedPixelFormat: OSType?
    let hevcProfileLevel: String?
    let maxAllowedFrameQP: Int?
    let targetBitrateKbps: Int
    let expectedFrameRate: Int
    let keyframeIntervalFrames: Int

    static let `default` = OwnedMediaEncodingConfiguration(
        expectedPixelFormat: nil,
        hevcProfileLevel: nil,
        maxAllowedFrameQP: nil,
        targetBitrateKbps: Config.ownedMediaBitrateKbps,
        expectedFrameRate: 30,
        keyframeIntervalFrames: 120
    )

    static func fromConfig() -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(
            expectedPixelFormat: Config.ownedMediaChroma.expectedPixelFormat,
            hevcProfileLevel: Config.ownedMediaHEVCProfile?.profileLevel,
            maxAllowedFrameQP: Config.ownedMediaMaxQP,
            targetBitrateKbps: Config.ownedMediaBitrateKbps,
            expectedFrameRate: Config.ownedMediaExpectedFrameRate,
            keyframeIntervalFrames: Config.ownedMediaKeyframeIntervalFrames
        )
    }
}

enum OwnedMediaPipelinePhase: String, Equatable {
    case idle
    case admissionHold = "admission-hold"
    case encoding
    case sending
}

enum OwnedMediaCoalescedFrameBucket: String, Equatable {
    case rawCapture = "raw-capture"
    case admissionHold = "admission-hold"
    case encodeBusy = "encode-busy"
    case networkBackpressure = "network-backpressure"
}

private struct OwnedMediaFrameLifecycle {
    var frameId: UInt64
    let capturedAtUptimeNs: UInt64
    var admissionUptimeNs: UInt64?
    var encodeStartUptimeNs: UInt64?
    var encodeEndUptimeNs: UInt64?
    var sendStartUptimeNs: UInt64?
    var sendEndUptimeNs: UInt64?
    var ackUptimeNs: UInt64?
    var encodedBytes: Int = 0
    var packetCount: Int = 0
    var isKeyframe = false
    var requestedKeyframeReason: OwnedMediaKeyframeReason?
    var actualKeyframeReason: OwnedMediaKeyframeReason?
    var admissionMode: OwnedMediaCadenceMode = .normal
    var encodeBudget: OwnedMediaEncodeBudget?
    var scaleDown: Double = 1.0
    var sourceWidth: Int = 0
    var sourceHeight: Int = 0
    var encodeWidth: Int = 0
    var encodeHeight: Int = 0
}

private struct OwnedMediaEncodeTiming {
    let decision: OwnedMediaAdmissionDecision
    let budget: OwnedMediaEncodeBudget
    let admissionIntervalMs: Int
    let intervalMs: Int
}

final class OwnedMediaHostDiagnostics: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let lock = NSLock()
    private var phase: OwnedMediaPipelinePhase = .idle
    private var fpsWindow = OwnedMediaDiagnosticsFpsWindow(windowStartedAtUptimeNs: DispatchTime.now().uptimeNanoseconds)
    private var lifecycleByCaptureNs: [UInt64: OwnedMediaFrameLifecycle] = [:]
    private var lifecycleByFrameId: [UInt64: OwnedMediaFrameLifecycle] = [:]
    private var coalescedRawCapture = 0
    private var coalescedAdmissionHold = 0
    private var coalescedEncodeBusy = 0
    private var coalescedNetworkBackpressure = 0
    private var hevcVisualOnlyFallbacks = 0
    private var hevcBaselineRealignments = 0

    func setPhase(_ phase: OwnedMediaPipelinePhase) {
        lock.withLock {
            self.phase = phase
        }
    }

    func noteCaptured(_ frame: CapturedVideoFrame) {
        let now = DispatchTime.now().uptimeNanoseconds
        let fpsSample = lock.withLock {
            fpsWindow.incrementCaptured()
            return fpsWindow.flushIfDue(nowUptimeNs: now)
        }
        logFpsIfNeeded(fpsSample)
    }

    func noteCoalescedCurrentPhase() {
        let bucket = lock.withLock {
            switch phase {
            case .admissionHold:
                coalescedAdmissionHold += 1
                return OwnedMediaCoalescedFrameBucket.admissionHold
            case .encoding:
                coalescedEncodeBusy += 1
                return OwnedMediaCoalescedFrameBucket.encodeBusy
            case .sending:
                coalescedNetworkBackpressure += 1
                return OwnedMediaCoalescedFrameBucket.networkBackpressure
            case .idle:
                coalescedRawCapture += 1
                return OwnedMediaCoalescedFrameBucket.rawCapture
            }
        }
        logger.notice("owned media diag-skip bucket=\(bucket.rawValue, privacy: .public)")
    }

    func noteAdmissionHold(reason: String?, mode: OwnedMediaCadenceMode) {
        setPhase(.admissionHold)
        logger.notice("owned media admission-hold-diagnostic mode=\(String(describing: mode), privacy: .public) reason=\(reason ?? "unknown", privacy: .public)")
    }

    func noteHEVCVisualOnly(frameId: UInt64, fallbackReason: OwnedHybridHEVCFallbackReason?, reason: String) {
        let total = lock.withLock {
            hevcVisualOnlyFallbacks += 1
            return hevcVisualOnlyFallbacks
        }
        logger.notice("owned media hevc-visual-only frame=\(frameId, privacy: .public) fallbackReason=\(fallbackReason?.rawValue ?? "none", privacy: .public) reason=\(reason, privacy: .public) total=\(total, privacy: .public)")
    }

    func noteHEVCBaselineRealignment(frameId: UInt64, fallbackReason: OwnedHybridHEVCFallbackReason?) {
        let total = lock.withLock {
            hevcBaselineRealignments += 1
            return hevcBaselineRealignments
        }
        logger.notice("owned media hevc-baseline-realigned frame=\(frameId, privacy: .public) fallbackReason=\(fallbackReason?.rawValue ?? "none", privacy: .public) total=\(total, privacy: .public)")
    }

    func noteAdmitted(
        _ frame: CapturedVideoFrame,
        decision: OwnedMediaAdmissionDecision,
        budget: OwnedMediaEncodeBudget,
        sourcePixelSize: CapturePixelSize,
        encodePixelSize: CapturePixelSize,
        nowUptimeNs: UInt64
    ) {
        let fpsSample = lock.withLock {
            fpsWindow.incrementAdmitted()
            var lifecycle = OwnedMediaFrameLifecycle(
                frameId: 0,
                capturedAtUptimeNs: frame.capturedAtUptimeNs,
                admissionUptimeNs: nowUptimeNs,
                requestedKeyframeReason: decision.keyframeReason,
                admissionMode: decision.mode,
                encodeBudget: budget
            )
            lifecycle.scaleDown = budget.scaleDown
            lifecycle.sourceWidth = sourcePixelSize.width
            lifecycle.sourceHeight = sourcePixelSize.height
            lifecycle.encodeWidth = encodePixelSize.width
            lifecycle.encodeHeight = encodePixelSize.height
            lifecycleByCaptureNs[frame.capturedAtUptimeNs] = lifecycle
            return fpsWindow.flushIfDue(nowUptimeNs: nowUptimeNs)
        }
        logFpsIfNeeded(fpsSample)
    }

    func noteEncodeStarted(frame: CapturedVideoFrame, nowUptimeNs: UInt64) {
        lock.withLock {
            lifecycleByCaptureNs[frame.capturedAtUptimeNs]?.encodeStartUptimeNs = nowUptimeNs
        }
    }

    func noteEncoded(
        envelope: OwnedMediaFrameEnvelope,
        requestedKeyframeReason: OwnedMediaKeyframeReason?,
        actualKeyframeReason: OwnedMediaKeyframeReason?,
        nowUptimeNs: UInt64
    ) {
        let fpsSample = lock.withLock {
            fpsWindow.incrementEncoded()
            var lifecycle = lifecycleByCaptureNs.removeValue(forKey: envelope.header.capturedAtUptimeNs) ?? OwnedMediaFrameLifecycle(
                frameId: envelope.header.frameId,
                capturedAtUptimeNs: envelope.header.capturedAtUptimeNs
            )
            lifecycle.frameId = envelope.header.frameId
            lifecycle.encodeEndUptimeNs = nowUptimeNs
            lifecycle.encodedBytes = envelope.payload.count
            lifecycle.isKeyframe = envelope.header.isKeyframe
            lifecycle.requestedKeyframeReason = requestedKeyframeReason
            lifecycle.actualKeyframeReason = actualKeyframeReason
            lifecycleByFrameId[envelope.header.frameId] = lifecycle
            return fpsWindow.flushIfDue(nowUptimeNs: nowUptimeNs)
        }
        logFpsIfNeeded(fpsSample)
        if envelope.header.isKeyframe {
            logger.notice("owned media keyframe-result frame=\(envelope.header.frameId, privacy: .public) requestedReason=\(requestedKeyframeReason?.rawValue ?? "none", privacy: .public) actualReason=\(actualKeyframeReason?.rawValue ?? "unknown", privacy: .public) expected=\(requestedKeyframeReason != nil, privacy: .public) bytes=\(envelope.payload.count, privacy: .public)")
        }
    }

    func noteSent(envelope: OwnedMediaFrameEnvelope, stats: OwnedMediaSendStats, decision: OwnedMediaAdmissionDecision) {
        let now = DispatchTime.now().uptimeNanoseconds
        let snapshot = lock.withLock {
            fpsWindow.incrementSent()
            var lifecycle = lifecycleByFrameId[envelope.header.frameId] ?? OwnedMediaFrameLifecycle(
                frameId: envelope.header.frameId,
                capturedAtUptimeNs: envelope.header.capturedAtUptimeNs
            )
            lifecycle.sendStartUptimeNs = stats.sendStartUptimeNs
            lifecycle.sendEndUptimeNs = stats.sendEndUptimeNs
            lifecycle.encodedBytes = stats.encodedBytes
            lifecycle.packetCount = stats.packetCount
            lifecycle.isKeyframe = envelope.header.isKeyframe
            lifecycle.admissionMode = decision.mode
            lifecycleByFrameId[envelope.header.frameId] = lifecycle
            return (
                lifecycle: lifecycle,
                fps: fpsWindow.flushIfDue(nowUptimeNs: now),
                raw: coalescedRawCapture,
                hold: coalescedAdmissionHold,
                encode: coalescedEncodeBusy,
                network: coalescedNetworkBackpressure
            )
        }
        logFpsIfNeeded(snapshot.fps)
        logger.notice("owned media host-frame frame=\(envelope.header.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) keyframeReason=\(snapshot.lifecycle.actualKeyframeReason?.rawValue ?? snapshot.lifecycle.requestedKeyframeReason?.rawValue ?? "none", privacy: .public) mode=\(String(describing: decision.mode), privacy: .public) budgetMode=\(snapshot.lifecycle.encodeBudget?.mode.rawValue ?? "unknown", privacy: .public) budgetKbps=\(snapshot.lifecycle.encodeBudget?.bitrateKbps ?? 0, privacy: .public) budgetFps=\(snapshot.lifecycle.encodeBudget?.expectedFrameRate ?? 0, privacy: .public) scaleDown=\(snapshot.lifecycle.scaleDown, privacy: .public) sourceSize=\(snapshot.lifecycle.sourceWidth, privacy: .public)x\(snapshot.lifecycle.sourceHeight, privacy: .public) encodeSize=\(snapshot.lifecycle.encodeWidth, privacy: .public)x\(snapshot.lifecycle.encodeHeight, privacy: .public) captureToAdmissionMs=\(Self.ms(from: snapshot.lifecycle.capturedAtUptimeNs, to: snapshot.lifecycle.admissionUptimeNs), privacy: .public) encodeMs=\(Self.ms(from: snapshot.lifecycle.encodeStartUptimeNs, to: snapshot.lifecycle.encodeEndUptimeNs), privacy: .public) sendMs=\(stats.sendDurationMs, privacy: .public) bytes=\(stats.encodedBytes, privacy: .public) packets=\(stats.packetCount, privacy: .public) burst=\(stats.pacingBurstPacketCount, privacy: .public) pauseUs=\(stats.pacingBurstPauseUs, privacy: .public) pacingReason=\(stats.pacingReason.rawValue, privacy: .public) burstPauses=\(stats.burstPauseCount, privacy: .public) maxPacketGapMs=\(stats.maxInterPacketGapMs, privacy: .public) backpressure=\(stats.isBackpressured, privacy: .public) coalescedRaw=\(snapshot.raw, privacy: .public) coalescedAdmissionHold=\(snapshot.hold, privacy: .public) coalescedEncodeBusy=\(snapshot.encode, privacy: .public) coalescedNetwork=\(snapshot.network, privacy: .public)")
    }

    func noteAck(message: OwnedMediaControlMessage, admissionMode: OwnedMediaCadenceMode, unackedFrames: Int, unackedBytes: Int) {
        let now = DispatchTime.now().uptimeNanoseconds
        let snapshot = lock.withLock {
            fpsWindow.incrementAcked()
            var lifecycle = lifecycleByFrameId[message.frameId]
            lifecycle?.ackUptimeNs = now
            if let lifecycle {
                lifecycleByFrameId[message.frameId] = lifecycle
            }
            lifecycleByFrameId = lifecycleByFrameId.filter { $0.key >= message.frameId }
            return (lifecycle, fpsWindow.flushIfDue(nowUptimeNs: now))
        }
        logFpsIfNeeded(snapshot.1)
        guard let lifecycle = snapshot.0 else {
            logger.notice("owned media host-frame-ack frame=\(message.frameId, privacy: .public) missingLifecycle=true unacked=\(unackedFrames, privacy: .public) bytes=\(unackedBytes, privacy: .public) mode=\(String(describing: admissionMode), privacy: .public)")
            return
        }
        logger.notice("owned media host-frame-ack frame=\(message.frameId, privacy: .public) ackRttMs=\(Self.ms(from: lifecycle.sendEndUptimeNs, to: now), privacy: .public) captureToAckMs=\(Self.ms(from: lifecycle.capturedAtUptimeNs, to: now), privacy: .public) captureToAdmissionMs=\(Self.ms(from: lifecycle.capturedAtUptimeNs, to: lifecycle.admissionUptimeNs), privacy: .public) encodeMs=\(Self.ms(from: lifecycle.encodeStartUptimeNs, to: lifecycle.encodeEndUptimeNs), privacy: .public) sendMs=\(Self.ms(from: lifecycle.sendStartUptimeNs, to: lifecycle.sendEndUptimeNs), privacy: .public) renderGapMs=\(message.renderGapMs ?? 0, privacy: .public) frameAgeMs=\(message.frameAgeMs ?? 0, privacy: .public) unacked=\(unackedFrames, privacy: .public) bytes=\(unackedBytes, privacy: .public) mode=\(String(describing: admissionMode), privacy: .public)")
    }

    private func logFpsIfNeeded(_ sample: OwnedMediaDiagnosticsFpsSample?) {
        guard let sample else { return }
        logger.notice("owned media diag-fps capture=\(sample.fps(sample.captured), privacy: .public) admitted=\(sample.fps(sample.admitted), privacy: .public) encoded=\(sample.fps(sample.encoded), privacy: .public) sent=\(sample.fps(sample.sent), privacy: .public) acked=\(sample.fps(sample.acked), privacy: .public) capturedCount=\(sample.captured, privacy: .public) admittedCount=\(sample.admitted, privacy: .public) encodedCount=\(sample.encoded, privacy: .public) sentCount=\(sample.sent, privacy: .public) ackedCount=\(sample.acked, privacy: .public)")
    }

    private static func ms(from start: UInt64?, to end: UInt64?) -> Double {
        guard let start, let end, end >= start else { return 0 }
        return Double(end - start) / 1_000_000.0
    }
}

final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    private static let scrollHintFallbackGraceMs = 120

    static let mediaDatagramALPN = OwnedQuicListenerConfigurations.mediaDatagramALPN
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let codec: OwnedMediaCodec
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer
    private let graphicsAuthorizer: OwnedGraphicsChannelAuthorizer
    private let scrollActivityHintProvider: @Sendable () -> ScrollActivityHint?
    private let scrollRegionHintProvider: @Sendable () -> ScrollRegionFocusHint?
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-quic")
    private let lock = NSLock()
    private var mediaDatagramListener: NWListener?
    private var graphicsListener: NWListener?
    private var graphicsConnections: [ObjectIdentifier: NWConnection] = [:]
    private var graphicsChannels: [ObjectIdentifier: OwnedGraphicsChannelServer] = [:]
    private var latestPendingGraphicsConnectionId: ObjectIdentifier?
    private var activeGraphicsConnectionId: ObjectIdentifier?
    private var channel: (any OwnedMediaChannelServing)?
    private var videoSource: VideoFrameSource?
    private var frameMailbox: LatestCapturedFrameMailbox?
    private var encodePumpTask: Task<Void, Never>?
    private var admission = OwnedMediaEncodeAdmission()
    private var graphicsAdmission = OwnedGraphicsAdmission()
    private var graphicsBackpressure = GraphicsBackpressure(maxUnacked: Config.hybridMaxUnackedFrames)
    private var pendingGraphicsResetRequest: OwnedGraphicsResetRequest?
    private var graphicsRecoveryState: HybridGraphicsRecoveryState = .idle
    private var graphicsRecoveryHEVCGate = HybridGraphicsRecoveryHEVCGate()
    private let graphicsAckWaiter = OwnedGraphicsAckWaiter()
    private var motionBudgetState = OwnedMediaMotionBudgetState()
    private var diagnostics = OwnedMediaHostDiagnostics()
    private let frameScaler = OwnedMediaFrameScaler()
    private var started = false

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer,
        graphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer,
        scrollActivityHintProvider: @escaping @Sendable () -> ScrollActivityHint? = { nil },
        scrollRegionHintProvider: @escaping @Sendable () -> ScrollRegionFocusHint? = { nil }
    ) {
        self.codec = codec
        self.configuration = configuration
        self.authorizer = authorizer
        self.graphicsAuthorizer = graphicsAuthorizer
        self.scrollActivityHintProvider = scrollActivityHintProvider
        self.scrollRegionHintProvider = scrollRegionHintProvider
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        self.videoSource = videoSource
        stateContinuation.yield(.connecting)
        // Single reliable media path: only the graphics channel is served. The
        // datagram media listener is not started.
        try startGraphicsListener()
    }

    func stop() {
        lock.lock()
        let channel = self.channel
        self.channel = nil
        started = false
        let mediaDatagramListener = self.mediaDatagramListener
        self.mediaDatagramListener = nil
        let graphicsListener = self.graphicsListener
        self.graphicsListener = nil
        let graphicsConnections = Array(self.graphicsConnections.values)
        self.graphicsConnections.removeAll()
        let graphicsChannels = Array(self.graphicsChannels.values)
        self.graphicsChannels.removeAll()
        self.latestPendingGraphicsConnectionId = nil
        self.activeGraphicsConnectionId = nil
        self.graphicsRecoveryState = .idle
        let source = self.videoSource
        self.videoSource = nil
        let mailbox = self.frameMailbox
        self.frameMailbox = nil
        let pumpTask = self.encodePumpTask
        self.encodePumpTask = nil
        lock.unlock()
        pumpTask?.cancel()
        mailbox?.finish()
        source?.stop()
        mediaDatagramListener?.cancel()
        graphicsListener?.cancel()
        graphicsConnections.forEach { $0.cancel() }
        graphicsChannels.forEach { $0.close() }
        graphicsAckWaiter.reset()
        channel?.close()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func startQuicDatagramListener() throws {
        lock.lock()
        let existing = mediaDatagramListener
        lock.unlock()
        guard existing == nil else { return }
        let configuration = Self.mediaDatagramListenerConfiguration()
        guard let port = NWEndpoint.Port(rawValue: configuration.port) else {
            throw SessionRejected(reason: .malformed)
        }
        let listener = try NWListener(using: Self.makeQuicParameters(configuration: configuration), on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleQuicDatagramConnection(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media quic datagram listener state=\(String(describing: state), privacy: .public) port=\(Int(configuration.port), privacy: .public)")
            if case .failed(let error) = state {
                self?.logger.error("owned media quic datagram listener failed: \(String(describing: error), privacy: .public)")
                self?.stateContinuation.yield(.failed)
            }
        }
        lock.lock()
        self.mediaDatagramListener = listener
        lock.unlock()
        listener.start(queue: queue)
    }

    private func startGraphicsListener() throws {
        lock.lock()
        let existing = graphicsListener
        lock.unlock()
        guard existing == nil else { return }
        let configuration = Self.graphicsListenerConfiguration()
        guard let port = NWEndpoint.Port(rawValue: configuration.port) else {
            throw SessionRejected(reason: .malformed)
        }
        let listener = try NWListener(using: Self.makeQuicParameters(configuration: configuration), on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleGraphicsConnection(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned graphics quic listener state=\(String(describing: state), privacy: .public) port=\(Int(configuration.port), privacy: .public)")
            if case .failed(let error) = state {
                self?.logger.error("owned graphics quic listener failed: \(String(describing: error), privacy: .public)")
            }
        }
        lock.lock()
        self.graphicsListener = listener
        lock.unlock()
        listener.start(queue: queue)
    }

    static func mediaDatagramListenerConfiguration() -> OwnedQuicListenerConfiguration {
        OwnedQuicListenerConfigurations.mediaDatagram()
    }

    static func graphicsListenerConfiguration() -> OwnedQuicListenerConfiguration {
        OwnedQuicListenerConfigurations.graphics()
    }

    private static func makeQuicParameters(configuration: OwnedQuicListenerConfiguration) throws -> NWParameters {
        let identity = try TLSIdentityLoader(
            certURL: Config.tlsCertURL,
            keyURL: Config.tlsKeyURL,
            identityURL: Config.tlsIdentityURL
        ).loadIdentity()
        guard let secIdentity = sec_identity_create(identity) else {
            throw TLSIdentityError.noIdentityInBundle
        }
        let options = NWProtocolQUIC.Options(alpn: [configuration.alpn])
        options.direction = .bidirectional
        options.isDatagram = configuration.usesDatagrams
        if let maxDatagramFrameSize = configuration.maxDatagramFrameSize {
            options.maxDatagramFrameSize = maxDatagramFrameSize
        }
        sec_protocol_options_set_local_identity(options.securityProtocolOptions, secIdentity)
        return NWParameters(quic: options)
    }

    private func handleQuicDatagramConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receiveMessage { [weak self, weak connection] data, _, _, error in
            guard let self, let connection else { return }
            if let error {
                self.logger.error("owned media quic hello receive failed: \(String(describing: error), privacy: .public)")
                connection.cancel()
                return
            }
            guard let data else {
                connection.cancel()
                return
            }
            Task { [weak self, weak connection] in
                await self?.acceptDatagramHello(data, on: connection)
            }
        }
    }

    private func acceptDatagramHello(_ data: Data, on connection: NWConnection?) async {
        guard let connection else { return }
        do {
            let hello = try JSONDecoder().decode(MediaChannelHello.self, from: data)
            guard !hello.clientNonce.isEmpty else {
                throw SessionRejected(reason: .malformed)
            }
            let result = await authorizer(hello)
            switch result {
            case .accepted(let fingerprint):
                let serverNonce = try Self.randomBytes(count: 32)
                let key = MediaDatagramCrypto.key(
                    mediaCapability: hello.mediaCapability,
                    clientNonce: hello.clientNonce,
                    serverNonce: serverNonce
                )
                let ready = MediaChannelReady(sessionId: hello.sessionId, serverNonce: serverNonce)
                let readyData = try JSONEncoder().encode(ready)
                try await sendReady(readyData, on: connection)
                let channel = OwnedMediaChannelServer(
                    connection: connection,
                    fingerprint: fingerprint,
                    key: key,
                    onControlMessage: { [weak self] message in
                        self?.handleControlMessage(message)
                    }
                )
                installChannel(channel)
                logger.notice("owned media quic accepted fp=\(fingerprint.rawValue, privacy: .public)")
                try await startIfReady()
            case .rejected(let reason):
                logger.error("owned media quic rejected reason=\(reason.rawValue, privacy: .public) fp=\(hello.deviceFingerprint.rawValue, privacy: .public)")
                connection.cancel()
            }
        } catch {
            logger.error("owned media quic hello failed: \(String(describing: error), privacy: .public)")
            connection.cancel()
            stateContinuation.yield(.failed)
        }
    }

    private func handleGraphicsConnection(_ connection: NWConnection) {
        let identifier = ObjectIdentifier(connection)
        lock.withLock {
            graphicsConnections[identifier] = connection
            latestPendingGraphicsConnectionId = identifier
        }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            self?.logger.notice("owned graphics quic connection state=\(String(describing: state), privacy: .public)")
            switch state {
            case .ready:
                self?.logger.notice("owned graphics channel-connected")
            case .cancelled, .failed:
                self?.logger.notice("owned graphics channel-disconnected state=\(String(describing: state), privacy: .public)")
                if let connection {
                    self?.removeGraphicsConnection(connection, reason: String(describing: state))
                }
            default:
                break
            }
        }
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak connection] data, _, _, error in
            guard let self, let connection else { return }
            if let error {
                self.logger.error("owned graphics quic hello receive failed: \(String(describing: error), privacy: .public)")
                self.removeGraphicsConnection(connection, reason: "hello-receive-failed")
                connection.cancel()
                return
            }
            guard let data else {
                self.logger.error("owned graphics quic hello failed: missing data")
                self.removeGraphicsConnection(connection, reason: "missing-hello")
                connection.cancel()
                return
            }
            Task { [weak self, weak connection] in
                await self?.acceptGraphicsHello(data, on: connection)
            }
        }
    }

    private func acceptGraphicsHello(_ data: Data, on connection: NWConnection?) async {
        guard let connection else { return }
        do {
            let hello = try OwnedGraphicsHandshake.validateHelloData(data)
            let result = await graphicsAuthorizer(hello)
            switch result {
            case .accepted(let fingerprint):
                guard consumePendingGraphicsConnection(connection) else {
                    logger.notice("owned graphics stale-hello-ignored session=\(hello.sessionId, privacy: .public)")
                    connection.cancel()
                    return
                }
                let serverNonce = try Self.randomBytes(count: 32)
                let ready = GraphicsChannelReady(sessionId: hello.sessionId, serverNonce: serverNonce)
                let readyData = try JSONEncoder().encode(ready)
                try await sendReady(readyData, on: connection)
                logger.notice("owned graphics reset acked session=\(hello.sessionId, privacy: .public)")
                installGraphicsChannel(OwnedGraphicsChannelServer(
                    connection: connection,
                    onFrameAck: { [weak self] connectionId, ack in
                        self?.noteGraphicsFrameAck(ack, connectionId: connectionId)
                    },
                    onResetRequest: { [weak self] request in
                        self?.handleGraphicsResetRequest(request)
                    }
                ))
                logger.notice("owned graphics quic accepted fp=\(fingerprint.rawValue, privacy: .public) session=\(hello.sessionId, privacy: .public)")
            case .rejected(let reason):
                logger.error("owned graphics quic rejected reason=\(reason.rawValue, privacy: .public) fp=\(hello.deviceFingerprint.rawValue, privacy: .public)")
                removeGraphicsConnection(connection, reason: "rejected-\(reason.rawValue)")
                connection.cancel()
            }
        } catch {
            logger.error("owned graphics quic hello failed: \(String(describing: error), privacy: .public)")
            removeGraphicsConnection(connection, reason: "hello-failed")
            connection.cancel()
        }
    }

    private func removeGraphicsConnection(_ connection: NWConnection, reason: String) {
        let removed = lock.withLock {
            let id = ObjectIdentifier(connection)
            let wasActive = activeGraphicsConnectionId == id
            if latestPendingGraphicsConnectionId == id {
                latestPendingGraphicsConnectionId = nil
            }
            _ = graphicsConnections.removeValue(forKey: id)
            let channel = graphicsChannels.removeValue(forKey: id)
            if wasActive {
                activeGraphicsConnectionId = nil
                graphicsAdmission.reset(config: Self.graphicsAdmissionConfig())
                graphicsBackpressure.reset()
                if graphicsRecoveryState != .failedCoolingDown {
                    graphicsRecoveryState = .reconnecting
                }
            }
            return (wasActive, channel)
        }
        removed.1?.close()
        if removed.0 {
            graphicsAckWaiter.reset()
            logger.notice("owned graphics active-channel-disconnected reason=\(reason, privacy: .public) recoveryState=\(self.currentGraphicsRecoveryState().rawValue, privacy: .public)")
        } else {
            logger.notice("owned graphics stale-channel-disconnected reason=\(reason, privacy: .public)")
        }
    }

    private func installGraphicsChannel(_ channel: OwnedGraphicsChannelServer) {
        let replaced = lock.withLock {
            let id = ObjectIdentifier(channel.connection)
            let previousChannels = graphicsChannels.filter { key, _ in key != id }.map(\.value)
            let previousConnections = graphicsConnections.filter { key, _ in key != id }.map(\.value)
            graphicsChannels = [id: channel]
            graphicsConnections = [id: channel.connection]
            latestPendingGraphicsConnectionId = nil
            activeGraphicsConnectionId = id
            graphicsAdmission.reset(config: Self.graphicsAdmissionConfig())
            graphicsBackpressure.reset()
            graphicsRecoveryState = pendingGraphicsResetRequest == nil ? .idle : .reconnecting
            return (previousChannels, previousConnections)
        }
        graphicsAckWaiter.reset()
        replaced.0.forEach { $0.close() }
        replaced.1.forEach { $0.cancel() }
        if !replaced.0.isEmpty || !replaced.1.isEmpty {
            logger.notice("owned graphics active-channel-replaced oldChannels=\(replaced.0.count, privacy: .public) oldConnections=\(replaced.1.count, privacy: .public)")
        }
        // The graphics channel is the only media path, so the capture pump
        // starts once the first graphics channel is installed and a source is
        // available. Subsequent installs are no-ops because the pump is started
        // exactly once (guarded by claimStartIfReady).
        Task { [weak self] in
            do {
                try await self?.startIfReady()
            } catch {
                self?.logger.error("owned media pump start failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func latestGraphicsChannel() -> OwnedGraphicsChannelServer? {
        lock.withLock {
            guard let activeGraphicsConnectionId,
                  let channel = graphicsChannels[activeGraphicsConnectionId],
                  channel.isOpen else {
                return nil
            }
            return channel
        }
    }

    private func consumePendingGraphicsConnection(_ connection: NWConnection) -> Bool {
        lock.withLock {
            let id = ObjectIdentifier(connection)
            guard latestPendingGraphicsConnectionId == id,
                  graphicsConnections[id] != nil else {
                return false
            }
            latestPendingGraphicsConnectionId = nil
            return true
        }
    }

    private func currentGraphicsRecoveryState() -> HybridGraphicsRecoveryState {
        lock.withLock { graphicsRecoveryState }
    }

    private func isActiveGraphicsConnection(_ connectionId: ObjectIdentifier) -> Bool {
        lock.withLock {
            activeGraphicsConnectionId == connectionId
        }
    }

    private func setGraphicsRecoveryState(_ state: HybridGraphicsRecoveryState, reason: String) {
        let previous = lock.withLock {
            let previous = graphicsRecoveryState
            graphicsRecoveryState = state
            return previous
        }
        if previous != state {
            logger.notice("owned graphics recovery state=\(state.rawValue, privacy: .public) previous=\(previous.rawValue, privacy: .public) reason=\(reason, privacy: .public)")
        }
    }

    private func graphicsRecoveryHEVCDecision(
        reason: OwnedHybridHEVCFallbackReason?,
        nowUptimeNs: UInt64
    ) -> (HybridGraphicsRecoveryState, HybridGraphicsRecoveryHEVCDecision) {
        lock.withLock {
            let state = graphicsRecoveryState
            let decision = graphicsRecoveryHEVCGate.decision(
                reason: reason,
                recoveryState: state,
                nowUptimeNs: nowUptimeNs,
                minIntervalMs: Config.hybridGraphicsFallbackMinIntervalMs
            )
            return (state, decision)
        }
    }

    private func installChannel(_ channel: any OwnedMediaChannelServing) {
        lock.lock()
        self.channel?.close()
        self.channel = channel
        lock.unlock()
    }

    private func sendReady(_ data: Data, on connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }

    private func startIfReady() async throws {
        guard let source = claimStartIfReady() else { return }
        let mailbox = LatestCapturedFrameMailbox()
        let diagnostics = OwnedMediaHostDiagnostics()
        let pumpTask = Task { [weak self, mailbox] in
            guard let self else { return }
            await self.runEncodePump(
                mailbox: mailbox,
                diagnostics: diagnostics
            )
        }
        lock.withLock {
            self.frameMailbox = mailbox
            self.encodePumpTask = pumpTask
            self.diagnostics = diagnostics
        }
        try await source.start { [mailbox, diagnostics] frame in
            diagnostics.noteCaptured(frame)
            if mailbox.submit(frame) {
                diagnostics.noteCoalescedCurrentPhase()
            }
        }
        stateContinuation.yield(.connected)
    }

    private func runEncodePump(
        mailbox: LatestCapturedFrameMailbox,
        diagnostics: OwnedMediaHostDiagnostics
    ) async {
        var cadenceScheduler = OwnedMediaCadenceScheduler()
        var scrollDeltaEngine = ScrollDeltaEngine(
            maxDecodedResetStripePayloadBytes: Config.hybridResetStripeMaxDecodedBytes,
            maxWireResetStripeBytes: Config.hybridResetStripeMaxWireBytes
        )
        for await _ in mailbox.stream {
            guard !Task.isCancelled else { return }
            diagnostics.setPhase(.idle)
            guard var frame = mailbox.takeLatest() else { continue }

            var timing = currentEncodeTiming(nowUptimeNs: DispatchTime.now().uptimeNanoseconds)
            var intervalNs = UInt64(timing.intervalMs) * 1_000_000
            let delayNs = cadenceScheduler.delayBeforeNextAdmission(
                nowUptimeNs: DispatchTime.now().uptimeNanoseconds,
                intervalMs: timing.intervalMs
            )
            var totalDelayNs = delayNs
            if delayNs > 0 {
                try? await Task.sleep(nanoseconds: delayNs)
                if let newest = mailbox.takeLatest() {
                    frame = newest
                }
                timing = currentEncodeTiming(nowUptimeNs: DispatchTime.now().uptimeNanoseconds)
                let additionalDelayNs = cadenceScheduler.delayBeforeNextAdmission(
                    nowUptimeNs: DispatchTime.now().uptimeNanoseconds,
                    intervalMs: timing.intervalMs
                )
                if additionalDelayNs > 0 {
                    totalDelayNs += additionalDelayNs
                    try? await Task.sleep(nanoseconds: additionalDelayNs)
                    if let newest = mailbox.takeLatest() {
                        frame = newest
                    }
                    timing = currentEncodeTiming(nowUptimeNs: DispatchTime.now().uptimeNanoseconds)
                }
                intervalNs = UInt64(timing.intervalMs) * 1_000_000
            }
            _ = intervalNs
            _ = timing

            // Single reliable media path: the damage-driven graphics channel.
            // Without an active graphics channel there is nothing to send, so the
            // frame is dropped. There is no HEVC encoder and no datagram channel
            // to fall through to.
            guard let graphicsChannel = latestGraphicsChannel() else {
                diagnostics.noteAdmissionHold(reason: "graphics-disconnected", mode: currentAdmissionMode())
                continue
            }
            if peekPendingGraphicsResetRequest() != nil {
                scrollDeltaEngine.invalidateRetainedSurface()
                logger.notice("owned graphics reset consumed by encode pump")
            }
            if !graphicsBackpressureCanProduce() {
                // At the unacked-frame cap. Hold this frame entirely. The mailbox
                // coalesces dirtyRects while stalled, so the next produced frame
                // carries the freshest damage.
                diagnostics.noteAdmissionHold(reason: "backpressure-cap", mode: currentAdmissionMode())
                logger.notice("owned graphics backpressure-hold reason=unacked-cap maxUnacked=\(Config.hybridMaxUnackedFrames, privacy: .public)")
                continue
            }
            let nowBeforeProbe = DispatchTime.now().uptimeNanoseconds
            let inputScrollHint = scrollActivityHintProvider()
            let scrollHint = inputScrollHint?.isActive(nowUptimeNs: nowBeforeProbe) == true
                ? inputScrollHint
                : nil
            let graphics = scrollDeltaEngine.evaluate(frame, scrollHint: scrollHint)
            switch graphics.kind {
            case .accepted:
                guard let envelope = graphics.envelope else {
                    diagnostics.noteAdmissionHold(reason: "graphics-accepted-no-envelope", mode: currentAdmissionMode())
                    continue
                }
                do {
                    let encodedBytes = try await graphicsChannel.send(envelope)
                    noteGraphicsFrameSent(envelope, encodedBytes: encodedBytes)
                    scrollDeltaEngine.commitPendingSurface()
                    logger.notice("owned graphics accepted frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) commands=\(envelope.commands.count, privacy: .public) payloadBytes=\(envelope.payload.count, privacy: .public) acceptedBy=\(graphics.diagnostics?.acceptedBy ?? "unknown", privacy: .public) decision=\(graphics.diagnostics?.timeoutReason ?? "none", privacy: .public) confidence=\(graphics.diagnostics?.confidence ?? 0, privacy: .public) hintActive=\(graphics.diagnostics?.hintActive ?? false, privacy: .public) hintAxis=\(graphics.diagnostics?.hintAxis ?? "none", privacy: .public)")
                } catch {
                    logger.error("owned graphics send failed: \(String(describing: error), privacy: .public)")
                    if isActiveGraphicsConnection(ObjectIdentifier(graphicsChannel.connection)) {
                        graphicsChannel.close()
                        setGraphicsRecoveryState(.failedCoolingDown, reason: "send-failed")
                    }
                }
                continue
            case .reset:
                let envelopes = graphics.envelopes.isEmpty
                    ? graphics.envelope.map { [$0] } ?? []
                    : graphics.envelopes
                guard !envelopes.isEmpty else { continue }
                let resetConnectionId = ObjectIdentifier(graphicsChannel.connection)
                do {
                    setGraphicsRecoveryState(.resetting, reason: "reset-start")
                    for (index, envelope) in envelopes.enumerated() {
                        guard isActiveGraphicsConnection(resetConnectionId) else {
                            logger.notice("owned graphics reset abandoned reason=stale-channel frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public)")
                            throw OwnedGraphicsResetSendError.staleChannel(envelope.header.updateId)
                        }
                        let encodedBytes = try await graphicsChannel.send(envelope)
                        noteGraphicsFrameSent(envelope, encodedBytes: encodedBytes)
                        logger.notice("owned graphics reset stripe sent frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) stripe=\(index + 1, privacy: .public) stripes=\(envelopes.count, privacy: .public) commands=\(envelope.commands.count, privacy: .public) bytes=\(envelope.payload.count, privacy: .public) maxDecodedBytes=\(Config.hybridResetStripeMaxDecodedBytes, privacy: .public)")
                        let acked = await graphicsAckWaiter.wait(
                            for: envelope.header.updateId,
                            timeoutMs: Config.hybridResetStripeAckTimeoutMs
                        )
                        if acked {
                            logger.notice("owned graphics reset-stripe-ack frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) stripe=\(index + 1, privacy: .public) stripes=\(envelopes.count, privacy: .public)")
                        } else if !isActiveGraphicsConnection(resetConnectionId) {
                            logger.notice("owned graphics reset wait abandoned reason=stale-channel frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public)")
                            throw OwnedGraphicsResetSendError.staleChannel(envelope.header.updateId)
                        } else {
                            throw OwnedGraphicsResetSendError.ackTimeout(envelope.header.updateId)
                        }
                    }
                    scrollDeltaEngine.commitPendingSurface()
                    clearPendingGraphicsResetRequest()
                    setGraphicsRecoveryState(.idle, reason: "reset-complete")
                    if let first = envelopes.first, let last = envelopes.last {
                        logger.notice("owned graphics reset frame=\(first.header.frameId, privacy: .public) generation=\(first.header.surfaceGeneration, privacy: .public) stripes=\(envelopes.count, privacy: .public) lastFrame=\(last.header.frameId, privacy: .public)")
                    }
                } catch let error as OwnedGraphicsResetSendError {
                    logger.error("owned graphics reset send failed: \(String(describing: error), privacy: .public)")
                    switch error {
                    case .ackTimeout(let updateId):
                        logger.error("owned graphics reset-stripe-ack-timeout frame=\(updateId.frameId, privacy: .public) generation=\(updateId.surfaceGeneration, privacy: .public) timeoutMs=\(Config.hybridResetStripeAckTimeoutMs, privacy: .public)")
                    case .staleChannel(let updateId):
                        logger.notice("owned graphics reset stale-channel ignored frame=\(updateId.frameId, privacy: .public) generation=\(updateId.surfaceGeneration, privacy: .public)")
                    }
                    if isActiveGraphicsConnection(resetConnectionId) {
                        graphicsChannel.close()
                        setGraphicsRecoveryState(.failedCoolingDown, reason: "reset-ack-timeout")
                    }
                } catch {
                    logger.error("owned graphics reset send failed: \(String(describing: error), privacy: .public)")
                    if isActiveGraphicsConnection(resetConnectionId) {
                        graphicsChannel.close()
                        setGraphicsRecoveryState(.failedCoolingDown, reason: "reset-send-failed")
                    }
                }
                continue
            case .noChange:
                // The damage classifier saw nothing worth sending. The retained
                // surface already matches the screen.
                diagnostics.noteAdmissionHold(reason: "graphics-damage-nochange", mode: currentAdmissionMode())
                continue
            case .timeout, .rejected:
                // The damage path does not return these now. There is no HEVC
                // fallback; hold the frame.
                diagnostics.noteAdmissionHold(reason: "graphics-no-update", mode: currentAdmissionMode())
                continue
            }
        }
    }

    private static func cadenceLateNs(
        scheduler: OwnedMediaCadenceScheduler,
        admissionUptimeNs: UInt64,
        intervalMs: Int
    ) -> UInt64 {
        guard let lastAdmissionStartedAtUptimeNs = scheduler.lastAdmissionStartedAtUptimeNs else { return 0 }
        let expectedAdmissionNs = lastAdmissionStartedAtUptimeNs &+ UInt64(max(intervalMs, 1)) * 1_000_000
        guard admissionUptimeNs > expectedAdmissionNs else { return 0 }
        return admissionUptimeNs - expectedAdmissionNs
    }

    private static func scrollOwnershipUpdate(
        diagnostics: ScrollDeltaDiagnostics,
        frameId: UInt64,
        nowUptimeNs: UInt64
    ) -> (
        axis: ScrollActivityAxis,
        sign: Int,
        offsetPx: Int,
        frameId: UInt64,
        nowUptimeNs: UInt64
    )? {
        if let dy = diagnostics.acceptedDy, dy != 0 {
            return (.vertical, dy < 0 ? -1 : 1, dy, frameId, nowUptimeNs)
        }
        if let dx = diagnostics.acceptedDx, dx != 0 {
            return (.horizontal, dx < 0 ? -1 : 1, dx, frameId, nowUptimeNs)
        }
        return nil
    }

    private func resolvedKeyframeReason(
        frameId: UInt64,
        decision: OwnedMediaAdmissionDecision
    ) -> OwnedMediaKeyframeReason? {
        if frameId == 1 {
            return .initial
        }
        if let keyframeReason = decision.keyframeReason {
            return keyframeReason
        }
        if decision.allowPeriodicKeyframe,
           frameId.isMultiple(of: UInt64(configuration.keyframeIntervalFrames)) {
            return .periodic
        }
        return nil
    }

    private func currentEncodeTiming(nowUptimeNs: UInt64) -> OwnedMediaEncodeTiming {
        lock.withLock {
            let config = makeBackpressureConfig()
            let decision = admission.decision(nowUptimeNs: nowUptimeNs, config: config)
            let budget = motionBudgetState.choose(
                policy: makeMotionBudgetPolicy(),
                mode: admission.mode,
                frameAgeMs: admission.latestClientFrameAgeMs,
                backlogFrames: admission.latestClientBacklogFrames,
                unacknowledgedBytes: admission.unacknowledgedBytes,
                nowUptimeNs: nowUptimeNs
            )
            let admissionIntervalMs = admission.encodeIntervalMs(config: config)
            let intervalMs = OwnedMediaEncodeCadencePolicy.intervalMs(
                admissionIntervalMs: admissionIntervalMs,
                budget: budget
            )
            return OwnedMediaEncodeTiming(
                decision: decision,
                budget: budget,
                admissionIntervalMs: admissionIntervalMs,
                intervalMs: intervalMs
            )
        }
    }

    private func makeMotionBudgetPolicy() -> OwnedMediaMotionBudgetPolicy {
        OwnedMediaMotionBudgetPolicy(
            enabled: Config.ownedMediaMotionBudgetEnabled,
            restBitrateKbps: configuration.targetBitrateKbps,
            restFps: configuration.expectedFrameRate,
            restScaleDown: Config.ownedMediaCaptureScaleDown,
            motionBitrateKbps: Config.ownedMediaMotionBitrateKbps,
            motionFps: Config.ownedMediaMotionFps,
            motionScaleDown: Config.ownedMediaMotionScaleDown,
            motionFrameAgeMs: Config.ownedMediaMotionFrameAgeMs,
            motionBacklogFrames: Config.ownedMediaMotionBacklogFrames,
            motionInflightBytes: Config.ownedMediaMotionInflightBytes,
            restBudgetHoldMs: Config.ownedMediaRestBudgetHoldMs
        )
    }

    private static func pixelSize(_ pixelBuffer: CVPixelBuffer) -> CapturePixelSize {
        CapturePixelSize(
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer)
        )
    }

    private func noteAdmissionSent(_ envelope: OwnedMediaFrameEnvelope, decision: OwnedMediaAdmissionDecision) {
        let now = DispatchTime.now().uptimeNanoseconds
        let snapshot = lock.withLock {
            let previousMode = admission.mode
            admission.noteSent(
                frameId: envelope.header.frameId,
                bytes: envelope.payload.count,
                capturedAtUptimeNs: envelope.header.capturedAtUptimeNs,
                isKeyframe: envelope.header.isKeyframe,
                nowUptimeNs: now,
                config: makeBackpressureConfig()
            )
            return (
                mode: admission.mode,
                previousMode: previousMode,
                unacked: admission.unacknowledgedFrameCount,
                bytes: admission.unacknowledgedBytes
            )
        }
        logger.notice("owned media admission-state mode=\(String(describing: snapshot.mode), privacy: .public) sent=\(envelope.header.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) unacked=\(snapshot.unacked, privacy: .public) bytes=\(snapshot.bytes, privacy: .public)")
        if snapshot.previousMode != .draining && snapshot.mode == .draining {
            logger.notice("owned media drain-enter afterSend=\(envelope.header.frameId, privacy: .public)")
        }
        if decision.mode == .draining && decision.forceKeyframe && envelope.header.isKeyframe {
            logger.notice("owned media keyframe-sent-after-drain frame=\(envelope.header.frameId, privacy: .public)")
        }
    }

    private func currentAdmissionMode() -> OwnedMediaCadenceMode {
        lock.withLock { admission.mode }
    }

    private func claimStartIfReady() -> VideoFrameSource? {
        lock.lock()
        let source = self.videoSource
        let hasGraphicsChannel = activeGraphicsConnectionId != nil
        let alreadyStarted = started
        if hasGraphicsChannel, source != nil, !started {
            started = true
        }
        lock.unlock()
        guard hasGraphicsChannel, let source, !alreadyStarted else { return nil }
        return source
    }

    private func handleControlMessage(_ message: OwnedMediaControlMessage) {
        switch message.kind {
        case .keyframeRequest:
            logger.notice("owned media keyframe requested after client frame=\(message.frameId, privacy: .public)")
            requestKeyframe()
        case .frameAck:
            noteFrameAck(message)
        case .packetResendRequest:
            break
        case .graphicsResetRequest:
            let request = OwnedGraphicsResetRequest(
                reason: message.reason ?? "media-fallback",
                lastCommittedSurfaceGeneration: message.graphicsSurfaceGeneration ?? 0,
                lastCommittedFrameId: message.frameId
            )
            logger.notice("owned graphics reset fallback received reason=\(request.reason, privacy: .public) generation=\(request.lastCommittedSurfaceGeneration, privacy: .public) frame=\(request.lastCommittedFrameId, privacy: .public)")
            handleGraphicsResetRequest(request)
        case .keepalive:
            break
        }
    }

    private func noteFrameAck(_ message: OwnedMediaControlMessage) {
        let snapshot = lock.withLock {
            let events = admission.noteAck(
                frameId: message.frameId,
                renderGapMs: message.renderGapMs,
                frameAgeMs: message.frameAgeMs,
                clientBacklogFrames: message.clientBacklogFrames,
                clientBacklogBytes: message.clientBacklogBytes,
                nowUptimeNs: DispatchTime.now().uptimeNanoseconds,
                config: makeBackpressureConfig()
            )
            return (
                events: events,
                mode: admission.mode,
                unacked: admission.unacknowledgedFrameCount,
                bytes: admission.unacknowledgedBytes,
                diagnostics: diagnostics
            )
        }
        snapshot.diagnostics.noteAck(
            message: message,
            admissionMode: snapshot.mode,
            unackedFrames: snapshot.unacked,
            unackedBytes: snapshot.bytes
        )
        if snapshot.events.enteredDrain {
            logger.notice("owned media drain-enter frameAgeMs=\(message.frameAgeMs ?? 0, privacy: .public) afterAck=\(message.frameId, privacy: .public)")
        }
        if snapshot.events.exitedDrain {
            logger.notice("owned media drain-exit afterAck=\(message.frameId, privacy: .public)")
        }
    }

    private func makeBackpressureConfig() -> OwnedMediaBackpressureConfig {
        OwnedMediaBackpressureConfig(
            frameAgeMs: Config.ownedMediaBackpressureFrameAgeMs,
            severeFrameAgeMs: Config.ownedMediaBackpressureSevereFrameAgeMs,
            maxInflightFrames: Config.ownedMediaBackpressureMaxInflightFrames,
            maxInflightBytes: Config.ownedMediaBackpressureMaxInflightBytes,
            expectedFrameRate: configuration.expectedFrameRate,
            behindEncodeIntervalMs: Config.ownedMediaBackpressureEncodeIntervalMs,
            severeEncodeIntervalMs: Config.ownedMediaBackpressureSevereEncodeIntervalMs,
            drainTimeoutMs: Config.ownedMediaDrainTimeoutMs,
            keyframeCooldownMs: Config.ownedMediaKeyframeCooldownMs,
            normalMaxUnackedFrames: Config.ownedMediaNormalMaxUnackedFrames,
            behindMaxUnackedFrames: Config.ownedMediaBehindMaxUnackedFrames,
            staleUnackedMs: Config.ownedMediaStaleUnackedMs
        )
    }

    private func logStaleUnackedAbandonment(_ decision: OwnedMediaAdmissionDecision) {
        guard decision.abandonedStaleUnackedCount > 0 else { return }
        logger.notice("owned media stale-unacked-abandoned oldest=\(decision.abandonedStaleUnackedOldestFrameId ?? 0, privacy: .public) count=\(decision.abandonedStaleUnackedCount, privacy: .public) bytes=\(decision.abandonedStaleUnackedBytes, privacy: .public)")
    }

    private func requestKeyframe() {
        let mode = lock.withLock {
            admission.noteKeyframeRequested()
            return admission.mode
        }
        if mode == .draining {
            logger.notice("owned media keyframe-deferred reason=draining")
        }
    }

    private func graphicsBackpressureCanProduce() -> Bool {
        lock.withLock {
            graphicsBackpressure.canProduce()
        }
    }

    private func noteGraphicsFrameSent(_ envelope: OwnedGraphicsFrameEnvelope, encodedBytes: Int) {
        let inFlight = lock.withLock { () -> Int in
            graphicsBackpressure.noteSent(frameId: envelope.header.frameId)
            return graphicsBackpressure.inFlight
        }
        logger.notice("owned graphics in-flight-sent frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) bytes=\(encodedBytes, privacy: .public) inFlight=\(inFlight, privacy: .public) maxUnacked=\(Config.hybridMaxUnackedFrames, privacy: .public)")
    }

    private func noteGraphicsFrameAck(_ ack: OwnedGraphicsFrameAck, connectionId: ObjectIdentifier) {
        let result = lock.withLock { () -> (inFlight: Int, mailbox: LatestCapturedFrameMailbox?)? in
            guard activeGraphicsConnectionId == connectionId else {
                return nil
            }
            graphicsAckWaiter.noteAck(ack)
            graphicsBackpressure.noteAck(frameId: ack.frameId)
            return (graphicsBackpressure.inFlight, frameMailbox)
        }
        guard let result else {
            logger.notice("owned graphics stale-ack-ignored frame=\(ack.frameId, privacy: .public) generation=\(ack.surfaceGeneration, privacy: .public)")
            return
        }
        // An ack frees a slot in the unacked-frame cap. Wake the pump with the
        // latest frame so a held (coalesced) frame is produced immediately
        // instead of waiting for the next capture callback.
        _ = result.mailbox?.wakeWithLatestFrame()
        logger.notice("owned graphics ack-applied frame=\(ack.frameId, privacy: .public) generation=\(ack.surfaceGeneration, privacy: .public) inFlight=\(result.inFlight, privacy: .public) queuedFrames=\(ack.queuedFrames, privacy: .public) queueBytes=\(ack.queueDepthBytes, privacy: .public) compositorMs=\(ack.compositorMs, privacy: .public)")
    }

    private func handleGraphicsResetRequest(_ request: OwnedGraphicsResetRequest) {
        lock.withLock {
            pendingGraphicsResetRequest = request
            graphicsAdmission.reset(config: Self.graphicsAdmissionConfig())
            graphicsBackpressure.reset()
        }
        logger.notice("owned graphics reset queued reason=\(request.reason, privacy: .public) generation=\(request.lastCommittedSurfaceGeneration, privacy: .public) frame=\(request.lastCommittedFrameId, privacy: .public)")
    }

    private func peekPendingGraphicsResetRequest() -> OwnedGraphicsResetRequest? {
        lock.withLock {
            pendingGraphicsResetRequest
        }
    }

    private func clearPendingGraphicsResetRequest() {
        lock.withLock {
            pendingGraphicsResetRequest = nil
        }
    }

    private static func graphicsAdmissionConfig() -> OwnedGraphicsAdmissionConfig {
        OwnedGraphicsAdmissionConfig(
            normalMaxUnackedFrames: Config.graphicsNormalMaxUnackedFrames,
            behindMaxUnackedFrames: Config.graphicsBehindMaxUnackedFrames,
            maxUnackedBytes: Config.graphicsMaxUnackedBytes,
            behindQueuedFrames: Config.graphicsBehindQueuedFrames,
            severeQueuedFrames: Config.graphicsSevereQueuedFrames,
            behindQueueDepthBytes: Config.graphicsBehindQueueDepthBytes,
            severeQueueDepthBytes: Config.graphicsSevereQueueDepthBytes,
            behindCompositorMs: Config.graphicsBehindCompositorMs,
            severeCompositorMs: Config.graphicsSevereCompositorMs
        )
    }

}

final class LatestCapturedFrameMailbox: @unchecked Sendable {
    let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private let lock = NSLock()
    private var latestFrame: CapturedVideoFrame?
    private var lastSubmittedFrame: CapturedVideoFrame?

    init() {
        var continuation: AsyncStream<Void>.Continuation!
        stream = AsyncStream(bufferingPolicy: .bufferingNewest(1)) { createdContinuation in
            continuation = createdContinuation
        }
        self.continuation = continuation
    }

    @discardableResult
    func submit(_ frame: CapturedVideoFrame) -> Bool {
        let replaced = lock.withLock {
            let replaced = latestFrame != nil
            latestFrame = frame
            lastSubmittedFrame = frame
            return replaced
        }
        continuation.yield(())
        return replaced
    }

    @discardableResult
    func wakeWithLatestFrame() -> Bool {
        let hasFrame = lock.withLock {
            guard let lastSubmittedFrame else { return false }
            latestFrame = lastSubmittedFrame
            return true
        }
        if hasFrame {
            continuation.yield(())
        }
        return hasFrame
    }

    func takeLatest() -> CapturedVideoFrame? {
        lock.withLock {
            let frame = latestFrame
            latestFrame = nil
            return frame
        }
    }

    func finish() {
        continuation.finish()
    }
}

private extension Config.OwnedMediaChroma {
    var expectedPixelFormat: OSType {
        switch self {
        case .yuv420:
            return kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        case .yuv444:
            return kCVPixelFormatType_444YpCbCr8BiPlanarFullRange
        case .bgra:
            return kCVPixelFormatType_32BGRA
        }
    }
}

private extension Config.OwnedMediaHEVCProfile {
    var profileLevel: String {
        switch self {
        case .main:
            return kVTProfileLevel_HEVC_Main_AutoLevel as String
        case .main10:
            return kVTProfileLevel_HEVC_Main10_AutoLevel as String
        case .main42210:
            return kVTProfileLevel_HEVC_Main42210_AutoLevel as String
        case .main444:
            return "HEVC_Main444_AutoLevel"
        case .main44410:
            return "HEVC_Main44410_AutoLevel"
        }
    }
}
