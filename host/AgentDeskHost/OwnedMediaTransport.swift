import CryptoKit
import Foundation
import Network
import os

@available(macOS 26.0, *)
final class QuicSessionHostMediaTransport: MediaTransport, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let source: VideoFrameSource
    private let datagrams: QUIC.Datagrams<QUICDatagram>
    private let mediaKey: SymmetricKey
    private let encoder = VideoToolboxOwnedMediaEncoder(
        codec: .hevc,
        configuration: .fromConfig()
    )
    private let pacer = OwnedMediaDatagramSendPacer(
        burstPacketCount: Config.ownedMediaDatagramBurstPacketCount,
        burstPauseUs: Config.ownedMediaDatagramBurstPauseUs
    )
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    private let encodeGate = OSAllocatedUnfairLock<EncodeState>(initialState: EncodeState())
    private let sendQueueGate = OSAllocatedUnfairLock<MediaSendQueueState>(
        initialState: MediaSendQueueState()
    )
    private var controlTask: Task<Void, Never>?

    init(
        source: VideoFrameSource,
        datagrams: QUIC.Datagrams<QUICDatagram>,
        mediaKey: SymmetricKey
    ) {
        self.source = source
        self.datagrams = datagrams
        self.mediaKey = mediaKey
        var stateCont: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { stateCont = $0 }
        stateContinuation = stateCont
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        stateContinuation.yield(.connected)
        try await source.start { [weak self] frame in
            self?.enqueue(frame)
        }
        startControlReceiveLoop()
    }

    func stop() {
        controlTask?.cancel()
        controlTask = nil
        source.stop()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func enqueue(_ frame: CapturedVideoFrame) {
        let shouldStart = encodeGate.withLock { state -> Bool in
            state.latest = frame
            if frame.forceKeyframe {
                state.forceKeyframe = true
            }
            if state.encoding { return false }
            state.encoding = true
            return true
        }
        guard shouldStart else { return }
        Task { [weak self] in
            await self?.drainEncodeQueue()
        }
    }

    private func drainEncodeQueue() async {
        while true {
            let step = encodeGate.withLock { state -> DrainStep in
                guard let frame = state.latest else {
                    state.encoding = false
                    return .idle
                }
                switch state.mediaState.reserveUpdateId(
                    nowNs: DispatchTime.now().uptimeNanoseconds
                ) {
                case .ready(let updateId):
                    state.latest = nil
                    let recoveryKeyframe = state.mediaState.takeRecoveryKeyframeRequest()
                    let forceKeyframe = state.forceKeyframe || recoveryKeyframe
                    state.forceKeyframe = false
                    return .job(
                        EncodeJob(
                            frame: frame,
                            updateId: updateId,
                            forceKeyframe: forceKeyframe,
                            recoveryKeyframe: recoveryKeyframe
                        )
                    )
                case .retry(let afterNs, let reason):
                    state.encoding = false
                    return .retry(afterNs: afterNs, reason: reason)
                }
            }
            switch step {
            case .idle:
                return
            case .retry(let afterNs, _):
                scheduleDrainRetry(afterNs: afterNs)
                return
            case .job(let job):
                if job.recoveryKeyframe {
                    logger.notice("owned media transport recovered stale in-flight admission and forced a keyframe")
                }
                guard let envelope = await encoder.encode(
                    job.frame,
                    updateId: job.updateId,
                    forceKeyframe: job.forceKeyframe,
                    requestedKeyframeReason: job.forceKeyframe
                        ? (job.recoveryKeyframe ? .transportRecovery : .clientRequest)
                        : nil
                ) else {
                    continue
                }
                await send(envelope)
            }
        }
    }

    private func scheduleDrainRetry(afterNs: UInt64) {
        let shouldSchedule = encodeGate.withLock { state -> Bool in
            guard state.latest != nil, !state.retryScheduled else { return false }
            state.retryScheduled = true
            return true
        }
        guard shouldSchedule else { return }
        Task { [weak self] in
            if afterNs > 0 {
                try? await Task.sleep(nanoseconds: afterNs)
            }
            guard let self else { return }
            self.encodeGate.withLock { state in
                state.retryScheduled = false
            }
            self.startDrainIfNeeded()
        }
    }

    private func send(_ envelope: OwnedMediaFrameEnvelope) async {
        let payload: Data
        do {
            payload = try envelope.encode()
        } catch {
            logger.error("frame envelope encode failed: \(String(describing: error), privacy: .public)")
            return
        }
        let packets: [Data]
        do {
            packets = try MediaDatagramFramePacket.packetize(
                frameId: envelope.header.frameId,
                isKeyframe: envelope.header.isKeyframe,
                sentAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
                payload: payload,
                key: mediaKey
            )
        } catch {
            logger.error("packetize failed: \(String(describing: error), privacy: .public)")
            return
        }
        let sentAtUptimeNs = DispatchTime.now().uptimeNanoseconds
        encodeGate.withLock { state in
            state.mediaState.noteSent(
                frameId: envelope.header.frameId,
                encodedBytes: payload.count,
                packets: packets,
                sentAtUptimeNs: sentAtUptimeNs
            )
        }
        let sent = await enqueuePackets(packets).value
        guard sent else { return }
        let liveTargets = encodeGate.withLock { state in
            let summary = state.productionDiagnostics.noteSent(
                bytes: payload.count,
                isKeyframe: envelope.header.isKeyframe,
                targetKbps: state.mediaState.targetKbps,
                targetFps: state.mediaState.targetFps,
                resolutionScale: state.mediaState.targetResolutionScale,
                nowNs: sentAtUptimeNs
            )
            if let summary {
                state.latestProductionSummary = summary
            }
            return (
                kbps: state.mediaState.targetKbps,
                fps: state.mediaState.targetFps,
                scale: state.mediaState.targetResolutionScale,
                productionSummary: summary
            )
        }
        if envelope.header.isKeyframe || envelope.header.frameId.isMultiple(of: 30) {
            logger.notice("owned media video sent frame=\(envelope.header.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public) packets=\(packets.count, privacy: .public) bitrateKbps=\(liveTargets.kbps, privacy: .public) fps=\(liveTargets.fps, privacy: .public) resolutionScale=\(liveTargets.scale, privacy: .public)")
        }
        if let summary = liveTargets.productionSummary {
            logger.notice(
                "owned media production summary actualFps=\(summary.actualFps, privacy: .public) targetFps=\(summary.targetFps, privacy: .public) fpsDeficit=\(summary.fpsDeficit, privacy: .public) frames=\(summary.frames, privacy: .public) keyframes=\(summary.keyframes, privacy: .public) sentKbps=\(summary.sentKbps, privacy: .public) targetKbps=\(summary.targetKbps, privacy: .public) maxGapMs=\(summary.maxGapMs, privacy: .public) resolutionScale=\(summary.resolutionScale, privacy: .public) windowMs=\(summary.windowMs, privacy: .public)"
            )
        }
    }

    private func enqueuePackets(_ packets: [Data]) -> Task<Bool, Never> {
        sendQueueGate.withLock { state -> Task<Bool, Never> in
            let prior = state.tail
            let task = Task { [weak self] in
                _ = await prior?.value
                guard let self else { return false }
                return await self.sendPacketsSerial(packets)
            }
            state.tail = task
            return task
        }
    }

    private func sendPacketsSerial(_ packets: [Data]) async -> Bool {
        let bursts = pacer.bursts(packetCount: packets.count)
        for (burstIndex, range) in bursts.enumerated() {
            if burstIndex > 0, pacer.pauseNanos > 0 {
                try? await Task.sleep(nanoseconds: pacer.pauseNanos)
            }
            for packet in packets[range] {
                guard await sendPacket(packet) else { return false }
            }
        }
        return true
    }

    private func sendPacket(_ packet: Data) async -> Bool {
        do {
            try await datagrams.send(packet)
            return true
        } catch {
            logger.error("video datagram send failed: \(String(describing: error), privacy: .public)")
            stateContinuation.yield(.failed)
            return false
        }
    }

    private func startDrainIfNeeded() {
        let shouldStart = encodeGate.withLock { state -> Bool in
            guard state.latest != nil, !state.encoding else { return false }
            state.encoding = true
            return true
        }
        guard shouldStart else { return }
        Task { [weak self] in
            await self?.drainEncodeQueue()
        }
    }

    private func sendResendPackets(_ packets: [Data]) {
        _ = enqueuePackets(packets)
    }

    private func handleFrameAck(_ frameId: UInt64) {
        encodeGate.withLock { state in
            _ = state.mediaState.noteAck(frameId: frameId)
        }
        startDrainIfNeeded()
    }

    private func handleLinkHealth(_ message: OwnedMediaControlMessage) {
        let completed = message.linkHealthCompletedFrames ?? 0
        let expired = message.linkHealthExpiredFrames ?? 0
        let decision = encodeGate.withLock { state in
            let productionSummary = state.latestProductionSummary
            state.latestProductionSummary = nil
            return state.mediaState.observeLinkHealth(
                completedFrames: completed,
                expiredFrames: expired,
                productionSummary: productionSummary
            )
        }
        logQualityDecision(decision)
        applyQualityDecision(decision, completed: completed, expired: expired)
    }

    private func applyQualityDecision(
        _ decision: MediaQualityDecision,
        completed: Int,
        expired: Int
    ) {
        let outcome = decision.outcome
        guard outcome.changed else { return }
        if outcome.bitrateChanged {
            encoder.updateBitrate(outcome.target.bitrateKbps)
            logger.notice("owned media video bitrate-step windowId=\(decision.observation.windowId, privacy: .public) target=\(outcome.target.bitrateKbps, privacy: .public)kbps rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public) completed=\(completed, privacy: .public) expired=\(expired, privacy: .public)")
        }
        if outcome.resolutionChanged {
            if let qualitySource = source as? QualitySelectableVideoFrameSource {
                qualitySource.setResolutionScale(
                    outcome.target.resolutionScale,
                    context: MediaCaptureScaleChangeContext(
                        windowId: decision.observation.windowId,
                        previousResolutionScale: outcome.previousTarget.resolutionScale,
                        nextResolutionScale: outcome.target.resolutionScale
                    )
                )
            }
            encodeGate.withLock { state in
                state.latest = nil
                state.forceKeyframe = true
                state.mediaState.resetForQualityChange()
            }
            logger.notice("owned media video resolution-step windowId=\(decision.observation.windowId, privacy: .public) scale=\(outcome.target.resolutionScale, privacy: .public) bitrate=\(outcome.target.bitrateKbps, privacy: .public)kbps fps=\(outcome.target.fps, privacy: .public) rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public)")
        }
        if outcome.fpsChanged {
            encoder.updateExpectedFrameRate(outcome.target.fps)
            logger.notice("owned media video fps-step windowId=\(decision.observation.windowId, privacy: .public) target=\(outcome.target.fps, privacy: .public)fps bitrate=\(outcome.target.bitrateKbps, privacy: .public)kbps rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public) completed=\(completed, privacy: .public) expired=\(expired, privacy: .public)")
        }
        logger.notice("mediaQualityTargetApplied windowId=\(decision.observation.windowId, privacy: .public) rung=\(outcome.target.rung.rawValue, privacy: .public) bitrateKbps=\(outcome.target.bitrateKbps, privacy: .public) fps=\(outcome.target.fps, privacy: .public) resolutionScale=\(outcome.target.resolutionScale, privacy: .public) bitrateApplied=\(outcome.bitrateChanged, privacy: .public) fpsApplied=\(outcome.fpsChanged, privacy: .public) resolutionApplied=\(outcome.resolutionChanged, privacy: .public) forcedKeyframe=\(outcome.resolutionChanged, privacy: .public) reason=\(outcome.reason, privacy: .public)")
        startDrainIfNeeded()
    }

    private func logQualityDecision(_ decision: MediaQualityDecision) {
        let observation = decision.observation
        let sample = observation.sample
        let production = observation.productionSummary
        logger.notice(
            "mediaQualityWindow windowId=\(observation.windowId, privacy: .public) currentRung=\(observation.previousTarget.rung.rawValue, privacy: .public) currentBitrateKbps=\(observation.previousTarget.bitrateKbps, privacy: .public) currentFps=\(observation.previousTarget.fps, privacy: .public) currentResolutionScale=\(observation.previousTarget.resolutionScale, privacy: .public) actualFps=\(production?.actualFps ?? -1, privacy: .public) fpsDeficit=\(production?.fpsDeficit ?? -1, privacy: .public) sentKbps=\(production?.sentKbps ?? -1, privacy: .public) frames=\(production?.frames ?? -1, privacy: .public) keyframes=\(production?.keyframes ?? -1, privacy: .public) maxSendGapMs=\(production?.maxGapMs ?? -1, privacy: .public) productionWindowMs=\(production?.windowMs ?? -1, privacy: .public) ackCount=\(observation.ackCount, privacy: .public) ackAgeP50Ms=\(self.formatMs(sample.ackAgeP50Ms), privacy: .public) ackAgeP95Ms=\(self.formatMs(sample.ackAgeP95Ms), privacy: .public) ackAgeMaxMs=\(self.formatMs(observation.ackAgeMaxMs), privacy: .public) inFlightFrames=\(observation.inFlightFrames, privacy: .public) inFlightBytes=\(observation.inFlightBytes, privacy: .public) oldestInflightMs=\(self.formatMs(observation.oldestInflightMs), privacy: .public) staleRecoveryCount=\(observation.staleRecoveryCount, privacy: .public) completedFrames=\(sample.completedFrames, privacy: .public) expiredFrames=\(sample.expiredFrames, privacy: .public) resendRequests=\(sample.resendRequests, privacy: .public) keyframeRequests=\(sample.keyframeRequests, privacy: .public) lossPermille=\(observation.signals.lossPermille, privacy: .public)"
        )
        logger.notice(
            "mediaQualityDecision windowId=\(observation.windowId, privacy: .public) previousRung=\(decision.outcome.previousTarget.rung.rawValue, privacy: .public) previousBitrateKbps=\(decision.outcome.previousTarget.bitrateKbps, privacy: .public) previousFps=\(decision.outcome.previousTarget.fps, privacy: .public) previousResolutionScale=\(decision.outcome.previousTarget.resolutionScale, privacy: .public) nextRung=\(decision.outcome.target.rung.rawValue, privacy: .public) nextBitrateKbps=\(decision.outcome.target.bitrateKbps, privacy: .public) nextFps=\(decision.outcome.target.fps, privacy: .public) nextResolutionScale=\(decision.outcome.target.resolutionScale, privacy: .public) reason=\(decision.outcome.reason, privacy: .public) changedAxes=\(decision.changedAxes, privacy: .public) lossPressure=\(observation.signals.lossPressure, privacy: .public) repairPressure=\(observation.signals.repairPressure, privacy: .public) queuePressure=\(observation.signals.queuePressure, privacy: .public) cadencePressure=\(observation.signals.cadencePressure, privacy: .public) stalePressure=\(observation.signals.stalePressure, privacy: .public) freezePressure=\(observation.signals.freezePressure, privacy: .public) expiredFrames=\(sample.expiredFrames, privacy: .public) lossPermille=\(observation.signals.lossPermille, privacy: .public) ackAgeP95Ms=\(self.formatMs(sample.ackAgeP95Ms), privacy: .public) fpsDeficit=\(production?.fpsDeficit ?? -1, privacy: .public) maxSendGapMs=\(production?.maxGapMs ?? -1, privacy: .public) staleRecoveryCount=\(observation.staleRecoveryCount, privacy: .public)"
        )
    }

    private func formatMs(_ value: Double?) -> String {
        guard let value else { return "nil" }
        return String(format: "%.1f", value)
    }

    private struct EncodeJob {
        let frame: CapturedVideoFrame
        let updateId: OwnedSurfaceUpdateId
        let forceKeyframe: Bool
        let recoveryKeyframe: Bool
    }

    private enum DrainStep {
        case idle
        case retry(afterNs: UInt64, reason: QuicSessionHostMediaState.RetryReason)
        case job(EncodeJob)
    }

    private func startControlReceiveLoop() {
        controlTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let message = try await datagrams.receive()
                    handleControlDatagram(message.content)
                } catch {
                    logger.notice("media control datagram receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    private func handleControlDatagram(_ data: Data) {
        guard let message = try? JSONDecoder().decode(OwnedMediaControlMessage.self, from: data) else {
            return
        }
        switch message.kind {
        case .keyframeRequest:
            encodeGate.withLock { state in
                state.mediaState.noteKeyframeRequest()
                state.forceKeyframe = true
            }
            startDrainIfNeeded()
        case .packetResendRequest:
            let packets = encodeGate.withLock { state in
                state.mediaState.noteResendRequest()
                return state.mediaState.packetsForResend(
                    frameId: message.frameId,
                    indexes: message.packetIndexes,
                    maxCount: Config.ownedMediaMaxResendPackets
                ).packets.map { $0.1 }
            }
            sendResendPackets(packets)
        case .frameAck:
            handleFrameAck(message.frameId)
        case .graphicsResetRequest:
            break
        case .keepalive:
            break
        case .linkHealth:
            handleLinkHealth(message)
        }
    }

    private struct EncodeState {
        var latest: CapturedVideoFrame?
        var encoding = false
        var retryScheduled = false
        var forceKeyframe = false
        var mediaState = QuicSessionHostMediaState()
        var productionDiagnostics = MediaProductionDiagnosticsTracker()
        var latestProductionSummary: MediaProductionSummary?
    }

    private struct MediaSendQueueState {
        var tail: Task<Bool, Never>?
    }
}
