import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import Network
import Security
import VideoToolbox
import os

typealias OwnedMediaDatagramAuthorizer = @Sendable (MediaChannelHello) async -> MediaCapabilityValidationResult

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let codec: OwnedMediaCodec
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer
    ) {
        self.codec = codec
        self.configuration = configuration
        self.authorizer = authorizer
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(codec: codec, configuration: configuration, authorizer: authorizer)
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
    private static let quicALPN = "agentdesk-owned-media"
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let codec: OwnedMediaCodec
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-quic")
    private let lock = NSLock()
    private var listener: NWListener?
    private var channel: (any OwnedMediaChannelServing)?
    private var videoSource: VideoFrameSource?
    private var encoder: VideoToolboxOwnedMediaEncoder?
    private var frameMailbox: LatestCapturedFrameMailbox?
    private var encodePumpTask: Task<Void, Never>?
    private var admission = OwnedMediaEncodeAdmission()
    private var motionBudgetState = OwnedMediaMotionBudgetState()
    private var diagnostics = OwnedMediaHostDiagnostics()
    private let frameScaler = OwnedMediaFrameScaler()
    private var started = false

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer
    ) {
        self.codec = codec
        self.configuration = configuration
        self.authorizer = authorizer
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        self.videoSource = videoSource
        stateContinuation.yield(.connecting)
        try startQuicDatagramListener()
        try await startIfReady()
    }

    func stop() {
        lock.lock()
        let channel = self.channel
        self.channel = nil
        started = false
        let listener = self.listener
        self.listener = nil
        let source = self.videoSource
        self.videoSource = nil
        let encoder = self.encoder
        self.encoder = nil
        let mailbox = self.frameMailbox
        self.frameMailbox = nil
        let pumpTask = self.encodePumpTask
        self.encodePumpTask = nil
        lock.unlock()
        pumpTask?.cancel()
        mailbox?.finish()
        source?.stop()
        encoder?.invalidate()
        listener?.cancel()
        channel?.close()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func startQuicDatagramListener() throws {
        lock.lock()
        let existing = listener
        lock.unlock()
        guard existing == nil else { return }
        guard let port = NWEndpoint.Port(rawValue: Config.signalingPort) else {
            throw SessionRejected(reason: .malformed)
        }
        let listener = try NWListener(using: Self.makeQuicDatagramParameters(), on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleQuicDatagramConnection(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media quic listener state=\(String(describing: state), privacy: .public)")
            if case .failed(let error) = state {
                self?.logger.error("owned media quic listener failed: \(String(describing: error), privacy: .public)")
                self?.stateContinuation.yield(.failed)
            }
        }
        lock.lock()
        self.listener = listener
        lock.unlock()
        listener.start(queue: queue)
    }

    private static func makeQuicDatagramParameters() throws -> NWParameters {
        let identity = try TLSIdentityLoader(
            certURL: Config.tlsCertURL,
            keyURL: Config.tlsKeyURL,
            identityURL: Config.tlsIdentityURL
        ).loadIdentity()
        guard let secIdentity = sec_identity_create(identity) else {
            throw TLSIdentityError.noIdentityInBundle
        }
        let options = NWProtocolQUIC.Options(alpn: [Self.quicALPN])
        options.direction = .bidirectional
        options.isDatagram = true
        options.maxDatagramFrameSize = Config.ownedMediaQuicMaxDatagramBytes
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
        guard let (channel, source) = claimStartIfReady() else { return }
        let encoder = VideoToolboxOwnedMediaEncoder(
            codec: codec,
            configuration: configuration
        )
        let mailbox = LatestCapturedFrameMailbox()
        let diagnostics = OwnedMediaHostDiagnostics()
        let pumpTask = Task { [weak self, weak channel, weak encoder, mailbox] in
            guard let self, let channel, let encoder else { return }
            await self.runEncodePump(
                mailbox: mailbox,
                encoder: encoder,
                channel: channel,
                diagnostics: diagnostics
            )
        }
        lock.withLock {
            self.encoder = encoder
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
        encoder: VideoToolboxOwnedMediaEncoder,
        channel: any OwnedMediaChannelServing,
        diagnostics: OwnedMediaHostDiagnostics
    ) async {
        var cadenceScheduler = OwnedMediaCadenceScheduler()
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

            let decision = timing.decision
            logStaleUnackedAbandonment(decision)
            if !decision.shouldEncode {
                diagnostics.noteAdmissionHold(reason: decision.holdReason, mode: decision.mode)
                logger.notice("owned media admission-hold mode=\(String(describing: decision.mode), privacy: .public) reason=\(decision.holdReason ?? "unknown", privacy: .public)")
                if decision.holdReason == "keyframe-inflight" {
                    logger.notice("owned media keyframe-suppressed-inflight mode=\(String(describing: decision.mode), privacy: .public)")
                }
                try? await Task.sleep(nanoseconds: intervalNs)
                continue
            }

            let admissionNs = DispatchTime.now().uptimeNanoseconds
            let cadenceLateNs = Self.cadenceLateNs(
                scheduler: cadenceScheduler,
                admissionUptimeNs: admissionNs,
                intervalMs: timing.intervalMs
            )
            let budget = timing.budget
            let sourcePixelSize = Self.pixelSize(frame.pixelBuffer)
            let encodeFrame: CapturedVideoFrame
            do {
                encodeFrame = try frameScaler.scaledFrame(frame, scaleDown: budget.scaleDown)
            } catch {
                logger.error("owned media pre-encode scale failed scaleDown=\(budget.scaleDown, privacy: .public) error=\(String(describing: error), privacy: .public)")
                diagnostics.setPhase(.idle)
                continue
            }
            let encodePixelSize = Self.pixelSize(encodeFrame.pixelBuffer)
            cadenceScheduler.noteAdmissionStarted(atUptimeNs: admissionNs)
            logger.notice("owned media cadence intervalMs=\(timing.intervalMs, privacy: .public) admissionIntervalMs=\(timing.admissionIntervalMs, privacy: .public) intervalSource=budget admissionDelayMs=\(Double(totalDelayNs) / 1_000_000.0, privacy: .public) cadenceLateMs=\(Double(cadenceLateNs) / 1_000_000.0, privacy: .public) mode=\(String(describing: decision.mode), privacy: .public) budgetMode=\(budget.mode.rawValue, privacy: .public) budgetKbps=\(budget.bitrateKbps, privacy: .public) budgetFps=\(budget.expectedFrameRate, privacy: .public) scaleDown=\(budget.scaleDown, privacy: .public) sourceSize=\(sourcePixelSize.width, privacy: .public)x\(sourcePixelSize.height, privacy: .public) encodeSize=\(encodePixelSize.width, privacy: .public)x\(encodePixelSize.height, privacy: .public)")
            diagnostics.noteAdmitted(
                encodeFrame,
                decision: decision,
                budget: budget,
                sourcePixelSize: sourcePixelSize,
                encodePixelSize: encodePixelSize,
                nowUptimeNs: admissionNs
            )
            diagnostics.setPhase(.encoding)
            diagnostics.noteEncodeStarted(frame: encodeFrame, nowUptimeNs: DispatchTime.now().uptimeNanoseconds)
            guard let envelope = await encoder.encode(
                encodeFrame,
                budget: budget,
                forceKeyframe: decision.forceKeyframe,
                allowPeriodicKeyframe: decision.allowPeriodicKeyframe,
                requestedKeyframeReason: decision.keyframeReason
            ) else {
                diagnostics.setPhase(.idle)
                continue
            }
            diagnostics.noteEncoded(
                envelope: envelope,
                requestedKeyframeReason: decision.keyframeReason,
                actualKeyframeReason: envelope.header.isKeyframe
                    ? resolvedKeyframeReason(frameId: envelope.header.frameId, decision: decision)
                    : nil,
                nowUptimeNs: DispatchTime.now().uptimeNanoseconds
            )
            do {
                diagnostics.setPhase(.sending)
                let sendStats = try await channel.send(envelope)
                diagnostics.noteSent(envelope: envelope, stats: sendStats, decision: decision)
                noteAdmissionSent(envelope, decision: decision)
            } catch {
                logger.error("owned media frame send failed: \(String(describing: error), privacy: .public)")
            }
            diagnostics.setPhase(.idle)
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

    private func claimStartIfReady() -> ((any OwnedMediaChannelServing), VideoFrameSource)? {
        lock.lock()
        let channel = self.channel
        let source = self.videoSource
        let alreadyStarted = started
        if channel != nil, source != nil, !started {
            started = true
        }
        lock.unlock()
        guard let channel, let source, !alreadyStarted else { return nil }
        return (channel, source)
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

}

final class LatestCapturedFrameMailbox: @unchecked Sendable {
    let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private let lock = NSLock()
    private var latestFrame: CapturedVideoFrame?

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
            return replaced
        }
        continuation.yield(())
        return replaced
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

final class VideoToolboxOwnedMediaEncoder: @unchecked Sendable {
    private struct PendingEncodedFrame {
        let capturedAtUptimeNs: UInt64
        let requestedKeyframeReason: OwnedMediaKeyframeReason?
        let expectedKeyframeReason: OwnedMediaKeyframeReason?
        let completion: @Sendable (OwnedMediaFrameEnvelope?) -> Void
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let codec: OwnedMediaCodec
    private let targetBitrateKbps: Int
    private let expectedFrameRate: Int
    private let configuration: OwnedMediaEncodingConfiguration
    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var size: (width: Int, height: Int)?
    private var frameId: UInt64 = 0
    private var forceNextKeyframe = false
    private var loggedFirstEncodedFrame = false
    private var pendingFrames: [UInt64: PendingEncodedFrame] = [:]
    private var appliedBudget = OwnedMediaAppliedEncodeBudget()

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default
    ) {
        self.codec = codec
        self.targetBitrateKbps = configuration.targetBitrateKbps
        self.expectedFrameRate = configuration.expectedFrameRate
        self.configuration = configuration
    }

    func encode(
        _ frame: CapturedVideoFrame,
        budget: OwnedMediaEncodeBudget,
        forceKeyframe: Bool = false,
        allowPeriodicKeyframe: Bool = true,
        requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
    ) async -> OwnedMediaFrameEnvelope? {
        await withCheckedContinuation { continuation in
            encode(
                frame,
                budget: budget,
                forceKeyframe: forceKeyframe,
                allowPeriodicKeyframe: allowPeriodicKeyframe,
                requestedKeyframeReason: requestedKeyframeReason
            ) { envelope in
                continuation.resume(returning: envelope)
            }
        }
    }

    private func encode(
        _ frame: CapturedVideoFrame,
        budget: OwnedMediaEncodeBudget,
        forceKeyframe requestedAdmissionKeyframe: Bool,
        allowPeriodicKeyframe: Bool,
        requestedKeyframeReason: OwnedMediaKeyframeReason?,
        completion: @escaping @Sendable (OwnedMediaFrameEnvelope?) -> Void
    ) {
        lock.lock()
        let sessionToEncode: VTCompressionSession
        let encodedFrameId: UInt64
        let frameProperties: CFDictionary?
        do {
            try ensureSession(for: frame.pixelBuffer)
            guard let session else {
                lock.unlock()
                completion(nil)
                return
            }
            sessionToEncode = session
            try applyBudgetIfNeeded(budget, to: sessionToEncode)
            frameId &+= 1
            encodedFrameId = frameId
            let requestedKeyframe = forceNextKeyframe || requestedAdmissionKeyframe
            forceNextKeyframe = false
            let periodicKeyframe = allowPeriodicKeyframe &&
                encodedFrameId.isMultiple(of: UInt64(configuration.keyframeIntervalFrames))
            let forceKeyframe = requestedKeyframe || encodedFrameId == 1 || periodicKeyframe
            let expectedKeyframeReason: OwnedMediaKeyframeReason? = forceKeyframe
                ? Self.resolveKeyframeReason(
                    frameId: encodedFrameId,
                    requestedReason: requestedKeyframe ? requestedKeyframeReason : nil,
                    periodicKeyframe: periodicKeyframe
                )
                : nil
            frameProperties = forceKeyframe
                ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
                : nil
            pendingFrames[encodedFrameId] = PendingEncodedFrame(
                capturedAtUptimeNs: frame.capturedAtUptimeNs,
                requestedKeyframeReason: requestedKeyframe ? requestedKeyframeReason : nil,
                expectedKeyframeReason: expectedKeyframeReason,
                completion: completion
            )
            if requestedKeyframe {
                logger.notice("owned encoder forcing requested keyframe frame=\(self.frameId, privacy: .public) reason=\(requestedKeyframeReason?.rawValue ?? "unknown", privacy: .public)")
            }
        } catch {
            if let session {
                VTCompressionSessionInvalidate(session)
            }
            session = nil
            size = nil
            appliedBudget.reset()
            lock.unlock()
            completion(nil)
            return
        }
        lock.unlock()

        let pts = CMTime(value: frame.presentationTimeNs, timescale: 1_000_000_000)
        let status = VTCompressionSessionEncodeFrame(
            sessionToEncode,
            imageBuffer: frame.pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: UInt(encodedFrameId)),
            infoFlagsOut: nil
        )
        if status != noErr {
            lock.lock()
            let pending = pendingFrames.removeValue(forKey: encodedFrameId)
            lock.unlock()
            pending?.completion(nil)
        }
    }

    func invalidate() {
        lock.lock()
        let pending = pendingFrames.values
        pendingFrames.removeAll()
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        size = nil
        appliedBudget.reset()
        lock.unlock()
        pending.forEach { $0.completion(nil) }
    }

    func requestKeyframe() {
        lock.lock()
        forceNextKeyframe = true
        lock.unlock()
    }

    private func ensureSession(for pixelBuffer: CVPixelBuffer) throws {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let actualPixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if let expectedPixelFormat = configuration.expectedPixelFormat,
           actualPixelFormat != expectedPixelFormat {
            logger.error("owned capture pixel format mismatch expected=\(Self.fourCC(expectedPixelFormat), privacy: .public) actual=\(Self.fourCC(actualPixelFormat), privacy: .public)")
            throw SessionRejected(reason: .malformed)
        }
        if let size, size.width == width, size.height == height, session != nil {
            return
        }
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        appliedBudget.reset()
        var newSession: VTCompressionSession?
        let encoderSpecification = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue as Any
        ] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: codec.codecType,
            encoderSpecification: encoderSpecification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: Self.outputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &newSession
        )
        guard status == noErr, let newSession else {
            throw SessionRejected(reason: .malformed)
        }
        try setProperty(kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue, on: newSession)
        try setProperty(kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse, on: newSession)
        try setProperty(kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: expectedFrameRate), on: newSession)
        try setProperty(kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: targetBitrateKbps * 1000), on: newSession)
        if codec == .hevc, let hevcProfileLevel = configuration.hevcProfileLevel {
            try setRequiredProperty(kVTCompressionPropertyKey_ProfileLevel, value: hevcProfileLevel as CFString, on: newSession)
        }
        if let maxAllowedFrameQP = configuration.maxAllowedFrameQP {
            try setRequiredProperty(kVTCompressionPropertyKey_MaxAllowedFrameQP, value: NSNumber(value: maxAllowedFrameQP), on: newSession)
        }
        VTCompressionSessionPrepareToEncodeFrames(newSession)
        session = newSession
        size = (width, height)
        logger.notice("owned encoder session codec=\(self.codec.rawValue, privacy: .public) size=\(width, privacy: .public)x\(height, privacy: .public) pixelFormat=\(Self.fourCC(actualPixelFormat), privacy: .public) profile=\(String(describing: self.configuration.hevcProfileLevel), privacy: .public) maxQP=\(String(describing: self.configuration.maxAllowedFrameQP), privacy: .public) bitrate=\(self.targetBitrateKbps, privacy: .public)kbps fps=\(self.expectedFrameRate, privacy: .public) keyframeInterval=\(self.configuration.keyframeIntervalFrames, privacy: .public)")
    }

    private func applyBudgetIfNeeded(_ budget: OwnedMediaEncodeBudget, to session: VTCompressionSession) throws {
        guard appliedBudget.shouldApply(budget) else { return }
        try setProperty(
            kVTCompressionPropertyKey_AverageBitRate,
            value: NSNumber(value: budget.bitrateKbps * 1_000),
            on: session
        )
        try setProperty(
            kVTCompressionPropertyKey_ExpectedFrameRate,
            value: NSNumber(value: budget.expectedFrameRate),
            on: session
        )
        appliedBudget.noteApplied(budget)
        logger.notice("owned encoder budget mode=\(budget.mode.rawValue, privacy: .public) bitrate=\(budget.bitrateKbps, privacy: .public)kbps fps=\(budget.expectedFrameRate, privacy: .public)")
    }

    private func setProperty(_ key: CFString, value: CFTypeRef, on session: VTCompressionSession) throws {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr || status == kVTPropertyNotSupportedErr else {
            throw SessionRejected(reason: .malformed)
        }
    }

    private func setRequiredProperty(_ key: CFString, value: CFTypeRef, on session: VTCompressionSession) throws {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr else {
            logger.error("owned required encoder property failed key=\(key, privacy: .public) status=\(status, privacy: .public)")
            throw SessionRejected(reason: .malformed)
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

    private static let outputCallback: VTCompressionOutputCallback = { refcon, sourceFrameRefcon, status, _, sampleBuffer in
        guard let refcon else {
            return
        }
        let encoder = Unmanaged<VideoToolboxOwnedMediaEncoder>.fromOpaque(refcon).takeUnretainedValue()
        guard status == noErr,
              let sampleBuffer else {
            encoder.handleEncodeFailed(sourceFrameRefcon: sourceFrameRefcon)
            return
        }
        encoder.handleEncoded(sampleBuffer: sampleBuffer, sourceFrameRefcon: sourceFrameRefcon)
    }

    private func handleEncodeFailed(sourceFrameRefcon: UnsafeMutableRawPointer?) {
        guard let sourceFrameRefcon else { return }
        let encodedFrameId = UInt64(UInt(bitPattern: sourceFrameRefcon))
        let pending: PendingEncodedFrame?
        lock.lock()
        pending = pendingFrames.removeValue(forKey: encodedFrameId)
        lock.unlock()
        pending?.completion(nil)
    }

    private func handleEncoded(sampleBuffer: CMSampleBuffer, sourceFrameRefcon: UnsafeMutableRawPointer?) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer),
              let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let sourceFrameRefcon else {
            return
        }
        let encodedFrameId = UInt64(UInt(bitPattern: sourceFrameRefcon))
        let pending: PendingEncodedFrame?
        let encodedSize: (width: Int, height: Int)?
        lock.lock()
        pending = pendingFrames.removeValue(forKey: encodedFrameId)
        encodedSize = size
        lock.unlock()
        guard let pending,
              let encodedSize else {
            return
        }
        let payload: Data
        do {
            payload = try Self.copyData(from: dataBuffer)
        } catch {
            pending.completion(nil)
            return
        }
        let isKeyframe = Self.isKeyframe(sampleBuffer)
        let parameterSets = isKeyframe ? Self.parameterSets(codec: codec, formatDescription: formatDescription) : nil
        let header = OwnedMediaFrameHeader(
            frameId: encodedFrameId,
            codec: codec,
            width: encodedSize.width,
            height: encodedSize.height,
            capturedAtUptimeNs: pending.capturedAtUptimeNs,
            presentationTimeNs: UInt64(CMSampleBufferGetPresentationTimeStamp(sampleBuffer).value),
            isKeyframe: isKeyframe,
            parameterSets: parameterSets
        )
        if !loggedFirstEncodedFrame {
            loggedFirstEncodedFrame = true
            logger.notice("owned first encoded frame codec=\(self.codec.rawValue, privacy: .public) size=\(encodedSize.width, privacy: .public)x\(encodedSize.height, privacy: .public) keyframe=\(isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        if isKeyframe {
            logger.notice("owned encoder keyframe-result frame=\(encodedFrameId, privacy: .public) requestedReason=\(pending.requestedKeyframeReason?.rawValue ?? "none", privacy: .public) actualReason=\(pending.expectedKeyframeReason?.rawValue ?? "unknown", privacy: .public) expected=\(pending.expectedKeyframeReason != nil, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        pending.completion(OwnedMediaFrameEnvelope(header: header, payload: payload))
    }

    private static func resolveKeyframeReason(
        frameId: UInt64,
        requestedReason: OwnedMediaKeyframeReason?,
        periodicKeyframe: Bool
    ) -> OwnedMediaKeyframeReason {
        if frameId == 1 {
            return .initial
        }
        if let requestedReason {
            return requestedReason
        }
        if periodicKeyframe {
            return .periodic
        }
        return .periodic
    }

    private static func copyData(from blockBuffer: CMBlockBuffer) throws -> Data {
        var totalLength = 0
        let lengthStatus = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: nil
        )
        guard lengthStatus == noErr else {
            throw SessionRejected(reason: .malformed)
        }
        var data = Data(count: totalLength)
        let copyStatus = data.withUnsafeMutableBytes { buffer in
            CMBlockBufferCopyDataBytes(
                blockBuffer,
                atOffset: 0,
                dataLength: totalLength,
                destination: buffer.baseAddress!
            )
        }
        guard copyStatus == noErr else {
            throw SessionRejected(reason: .malformed)
        }
        return data
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0 else {
            return true
        }
        let attachment = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
        return !CFDictionaryContainsKey(
            attachment,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
        )
    }

    private static func parameterSets(
        codec: OwnedMediaCodec,
        formatDescription: CMFormatDescription
    ) -> OwnedMediaParameterSets? {
        switch codec {
        case .h264:
            guard let sps = parameterSet(formatDescription, index: 0, hevc: false),
                  let pps = parameterSet(formatDescription, index: 1, hevc: false) else {
                return nil
            }
            return OwnedMediaParameterSets(sps: sps, pps: pps)
        case .hevc:
            guard let vps = parameterSet(formatDescription, index: 0, hevc: true),
                  let sps = parameterSet(formatDescription, index: 1, hevc: true),
                  let pps = parameterSet(formatDescription, index: 2, hevc: true) else {
                return nil
            }
            return OwnedMediaParameterSets(vps: vps, sps: sps, pps: pps)
        }
    }

    private static func parameterSet(
        _ formatDescription: CMFormatDescription,
        index: Int,
        hevc: Bool
    ) -> Data? {
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        let status: OSStatus
        if hevc {
            status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            )
        } else {
            status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            )
        }
        guard status == noErr, let pointer else { return nil }
        return Data(bytes: pointer, count: size)
    }
}

private extension OwnedMediaCodec {
    var codecType: CMVideoCodecType {
        switch self {
        case .hevc: return kCMVideoCodecType_HEVC
        case .h264: return kCMVideoCodecType_H264
        }
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
