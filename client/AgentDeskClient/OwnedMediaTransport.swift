import CryptoKit
import Foundation
import Network
import OSLog
import Security

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let host: String
    private let port: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant

    init(
        host: String,
        port: UInt16,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant
    ) {
        self.host = host
        self.port = port
        self.active = active
        self.mediaCapability = mediaCapability
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            host: host,
            port: port,
            active: active,
            mediaCapability: mediaCapability
        )
    }
}

final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    private static let quicALPN = "agentdesk-owned-media"
    private static let maxQuicDatagramBytes = 1_200
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.client.owned-media-quic")
    private let host: String
    private let port: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private var connection: NWConnection?
    private var receiveTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?

    init(
        host: String,
        port: UInt16,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant
    ) {
        self.host = host
        self.port = port
        self.active = active
        self.mediaCapability = mediaCapability
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws {
        guard let sink = videoSinks?[.detail] as? any OwnedMediaFrameSink else {
            throw MediaTransportError.notYetImplemented
        }
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            throw SessionRejected(reason: .malformed)
        }
        self.sink = sink
        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: endpointPort,
            using: Self.makeQuicDatagramParameters()
        )
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media quic state=\(String(describing: state), privacy: .public)")
            if case .failed = state {
                self?.stateContinuation.yield(.failed)
            }
        }
        stateContinuation.yield(.connecting)
        connection.start(queue: queue)

        let clientNonce = try Self.randomBytes(count: 32)
        let hello = MediaChannelHello(
            deviceFingerprint: active.deviceFingerprint,
            sessionId: active.sessionId,
            mediaCapability: mediaCapability.mediaCapability,
            clientNonce: clientNonce
        )
        try await send(JSONEncoder().encode(hello), on: connection)
        let ready = try await receiveReady(sessionId: active.sessionId, on: connection)
        let key = MediaDatagramCrypto.key(
            mediaCapability: mediaCapability.mediaCapability,
            clientNonce: clientNonce,
            serverNonce: ready.serverNonce
        )
        stateContinuation.yield(.connected)
        receiveTask = Task { [weak self, connection] in
            await self?.receiveLoop(connection: connection, key: key)
        }
    }

    func stop() {
        receiveTask?.cancel()
        receiveTask = nil
        connection?.cancel()
        connection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func receiveLoop(connection: NWConnection, key: SymmetricKey) async {
        let repairBuffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: UInt64(Config.ownedMediaRepairDeadlineMs) * 1_000_000,
            trackedFrameLimit: Config.ownedMediaResendRingFrames,
            maxResendPackets: Config.ownedMediaMaxResendPackets
        )
        var keyframeRecovery = OwnedMediaKeyframeRequestThrottle()
        var droppedPackets = 0
        var receivedPackets = 0
        var completedFrames = 0
        var skippedDeltasWaitingForKeyframe = 0
        var resendRequests = 0
        var resendPackets = 0
        var repairedFrames = 0
        var expiredFrames = 0
        var keyframeFallbacks = 0
        while !Task.isCancelled {
            do {
                let data = try await receive(on: connection)
                let packet = try MediaDatagramFramePacket.decode(data, key: key)
                receivedPackets += 1
                if receivedPackets == 1 || receivedPackets.isMultiple(of: 600) {
                    logger.notice("owned media quic received packet count=\(receivedPackets, privacy: .public) frame=\(packet.frameId, privacy: .public) index=\(packet.packetIndex, privacy: .public)/\(packet.packetCount, privacy: .public) bytes=\(data.count, privacy: .public)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("quic packets=\(receivedPackets) frame=\(packet.frameId) index=\(packet.packetIndex)/\(packet.packetCount)\ncomplete=\(completedFrames) repaired=\(repairedFrames) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) fallback=\(keyframeFallbacks)")
                    }
                }
                let repair = repairBuffer.accept(packet, now: DispatchTime.now().uptimeNanoseconds)
                for request in repair.resendRequests {
                    resendRequests += 1
                    resendPackets += request.packetIndexes.count
                    logger.notice("owned media quic packet-resend-request frame=\(request.frameId, privacy: .public) missing=\(request.packetIndexes.count, privacy: .public)")
                    try? await sendPacketResendRequest(
                        frameId: request.frameId,
                        packetIndexes: request.packetIndexes,
                        on: connection
                    )
                }
                for droppedFrame in repair.expiredFrames {
                    expiredFrames += 1
                    keyframeFallbacks += 1
                    logger.error("owned media quic expired incomplete frame=\(droppedFrame.frameId, privacy: .public) received=\(droppedFrame.received, privacy: .public)/\(droppedFrame.expected, privacy: .public) missing=\(droppedFrame.missingIndexes.count, privacy: .public)")
                    if keyframeRecovery.noteIncompleteFrame(now: DispatchTime.now().uptimeNanoseconds) {
                        try? await sendKeyframeRequest(afterFrameId: droppedFrame.frameId, on: connection)
                    }
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("expired frame=\(droppedFrame.frameId) received=\(droppedFrame.received)/\(droppedFrame.expected) missing=\(droppedFrame.missingIndexes.count)\nquic packets=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) fallback=\(keyframeFallbacks)")
                    }
                }
                repairedFrames += repair.repairedFrameCount
                for completed in repair.completedFrames {
                    completedFrames += 1
                    let envelope = try OwnedMediaFrameEnvelope.decode(completed.data)
                    if keyframeRecovery.isAwaitingKeyframe, !envelope.header.isKeyframe {
                        skippedDeltasWaitingForKeyframe += 1
                        if skippedDeltasWaitingForKeyframe == 1 || skippedDeltasWaitingForKeyframe.isMultiple(of: 30) {
                            logger.notice("owned media quic skipped delta while waiting for keyframe count=\(skippedDeltasWaitingForKeyframe, privacy: .public) frame=\(envelope.header.frameId, privacy: .public)")
                            if keyframeRecovery.noteSkippedDelta(now: DispatchTime.now().uptimeNanoseconds) {
                                try? await sendKeyframeRequest(afterFrameId: envelope.header.frameId, on: connection)
                            }
                        }
                        continue
                    }
                    if envelope.header.isKeyframe {
                        keyframeRecovery.noteKeyframe()
                        skippedDeltasWaitingForKeyframe = 0
                    }
                    if completedFrames == 1 || completedFrames.isMultiple(of: 60) || completed.wasRepaired {
                        logger.notice("owned media quic completed frame count=\(completedFrames, privacy: .public) frame=\(completed.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) repaired=\(completed.wasRepaired, privacy: .public) bytes=\(completed.data.count, privacy: .public) packets=\(completed.packetCount, privacy: .public)")
                        ownedMediaStderrTrace("complete count=\(completedFrames) frame=\(completed.frameId) key=\(envelope.header.isKeyframe) repaired=\(completed.wasRepaired) bytes=\(completed.data.count) packets=\(completed.packetCount) quic=\(receivedPackets) drops=\(droppedPackets) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) fallback=\(keyframeFallbacks)")
                        await MainActor.run { [weak self] in
                            self?.sink?.setOwnedMediaDebugStatus("completed=\(completedFrames) frame=\(completed.frameId) key=\(envelope.header.isKeyframe) repaired=\(repairedFrames) packets=\(completed.packetCount)\nquic=\(receivedPackets) malformed=\(droppedPackets) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) fallback=\(keyframeFallbacks)")
                        }
                    }
                    await MainActor.run { [weak self] in
                        self?.sink?.renderOwnedMediaFrame(envelope)
                    }
                }
            } catch is CancellationError {
                return
            } catch let error as MediaDatagramPacketError {
                droppedPackets += 1
                if droppedPackets == 1 || droppedPackets.isMultiple(of: 120) {
                    if keyframeRecovery.noteMalformedPacket(now: DispatchTime.now().uptimeNanoseconds) {
                        keyframeFallbacks += 1
                        try? await sendKeyframeRequest(afterFrameId: 0, on: connection)
                    }
                    logger.error("owned media quic dropped packet count=\(droppedPackets, privacy: .public) reason=\(error.debugSummary, privacy: .public)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("\(error.debugSummary)\ndrops=\(droppedPackets) quic=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) fallback=\(keyframeFallbacks)")
                    }
                }
                continue
            } catch {
                logger.error("owned media quic receive failed: \(String(describing: error), privacy: .public)")
                await MainActor.run { [weak self] in
                    self?.sink?.setOwnedMediaDebugStatus("receive failed \(String(describing: error))\nquic packets=\(receivedPackets) complete=\(completedFrames)")
                }
                stateContinuation.yield(.failed)
                return
            }
        }
    }

    private func send(_ data: Data, on connection: NWConnection) async throws {
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

    private func sendKeyframeRequest(afterFrameId frameId: UInt64, on connection: NWConnection) async throws {
        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: frameId)
        let data = try JSONEncoder().encode(message)
        try await send(data, on: connection)
        logger.notice("owned media quic requested keyframe after frame=\(frameId, privacy: .public)")
    }

    private func sendPacketResendRequest(
        frameId: UInt64,
        packetIndexes: [UInt16],
        on connection: NWConnection
    ) async throws {
        let message = OwnedMediaControlMessage(
            kind: .packetResendRequest,
            frameId: frameId,
            packetIndexes: packetIndexes
        )
        let data = try JSONEncoder().encode(message)
        try await send(data, on: connection)
    }

    private func receiveReady(sessionId: String, on connection: NWConnection) async throws -> MediaChannelReady {
        let data = try await receive(on: connection)
        let ready = try JSONDecoder().decode(MediaChannelReady.self, from: data)
        guard ready.sessionId == sessionId, !ready.serverNonce.isEmpty else {
            throw SessionRejected(reason: .malformed)
        }
        return ready
    }

    private func receive(on connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receiveMessage { data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: SessionRejected(reason: .malformed))
                }
            }
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

    private static func makeQuicDatagramParameters() -> NWParameters {
        let options = NWProtocolQUIC.Options(alpn: [Self.quicALPN])
        options.direction = .bidirectional
        options.isDatagram = true
        options.maxDatagramFrameSize = Self.maxQuicDatagramBytes
        #if DEBUG
        sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, _, complete in
            complete(true)
        }, DispatchQueue.main)
        #endif
        return NWParameters(quic: options)
    }
}

private func ownedMediaStderrTrace(_ message: String) {
    guard ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_STDERR_TRACE"] == "1",
          let data = "[owned-media] \(message)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}
