import CryptoKit
import Foundation
import Network
import OSLog
import Security

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let host: String
    private let port: UInt16
    private let graphicsPort: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant

    init(
        host: String,
        port: UInt16,
        graphicsPort: UInt16 = Config.graphicsPort,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant
    ) {
        self.host = host
        self.port = port
        self.graphicsPort = graphicsPort
        self.active = active
        self.mediaCapability = mediaCapability
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            host: host,
            port: port,
            graphicsPort: graphicsPort,
            active: active,
            mediaCapability: mediaCapability
        )
    }
}

final class OwnedGraphicsTransport: @unchecked Sendable {
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-graphics")
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.client.owned-graphics-quic")
    private let plan: ClientGraphicsConnectionPlan
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private var connection: NWConnection?
    private var pendingConnection: NWConnection?
    private var receiveTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?
    private let onFallbackResetRequest: @Sendable (OwnedGraphicsResetRequest) async -> Void
    private let onDisconnected: @Sendable (String) -> Void

    init(
        plan: ClientGraphicsConnectionPlan,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        sink: (any OwnedMediaFrameSink)?,
        onFallbackResetRequest: @escaping @Sendable (OwnedGraphicsResetRequest) async -> Void,
        onDisconnected: @escaping @Sendable (String) -> Void
    ) {
        self.plan = plan
        self.active = active
        self.mediaCapability = mediaCapability
        self.sink = sink
        self.onFallbackResetRequest = onFallbackResetRequest
        self.onDisconnected = onDisconnected
    }

    func start() async throws {
        guard let endpointPort = NWEndpoint.Port(rawValue: self.plan.port) else {
            throw SessionRejected(reason: .malformed)
        }
        let connection = NWConnection(
            host: NWEndpoint.Host(self.plan.host),
            port: endpointPort,
            using: Self.makeReliableQuicParameters(alpn: self.plan.alpn)
        )
        self.pendingConnection = connection
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned graphics quic state=\(String(describing: state), privacy: .public)")
        }
        connection.start(queue: self.queue)

        let clientNonce = try Self.randomBytes(count: 32)
        let hello = ClientGraphicsChannelHandshake.makeHello(
            active: self.active,
            mediaCapability: self.mediaCapability,
            clientNonce: clientNonce
        )
        try await self.send(JSONEncoder().encode(hello), on: connection)
        _ = try await self.receiveReady(expectedSessionId: self.active.sessionId, on: connection)
        self.pendingConnection = nil
        self.connection = connection
        self.logger.notice("owned graphics quic ready port=\(Int(self.plan.port), privacy: .public)")
        receiveTask = Task { [weak self, connection] in
            await self?.receiveFrames(on: connection)
        }
    }

    func stop() {
        receiveTask?.cancel()
        receiveTask = nil
        self.pendingConnection?.cancel()
        self.pendingConnection = nil
        self.connection?.cancel()
        self.connection = nil
    }

    func sendResetRequest(_ request: OwnedGraphicsResetRequest) async {
        guard let connection else {
            ownedMediaStderrTrace("graphics-reset-request-fallback reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=no-connection")
            await onFallbackResetRequest(request)
            onDisconnected("reset-no-connection")
            return
        }
        do {
            try await send(OwnedGraphicsControlStreamFrame.encode(request), on: connection)
            ownedMediaStderrTrace("graphics-reset-request reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId)")
        } catch {
            logger.error("owned graphics reset request failed: \(String(describing: error), privacy: .public)")
            ownedMediaStderrTrace("graphics-reset-request-failed reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) error=\(String(describing: error))")
            await onFallbackResetRequest(request)
            onDisconnected("reset-send-failed")
        }
    }

    private func receiveFrames(on connection: NWConnection) async {
        var framer = OwnedGraphicsStreamFrameParser()
        while !Task.isCancelled {
            do {
                let chunk = try await receive(on: connection, maximumLength: 256 * 1024)
                let frames = try framer.append(chunk)
                for frame in frames {
                    let ack = await MainActor.run { [weak self] in
                        self?.sink?.renderOwnedGraphicsFrame(frame)
                    }
                    if let ack {
                        try await send(OwnedGraphicsControlStreamFrame.encode(ack), on: connection)
                        ownedMediaStderrTrace("graphics-ack frame=\(ack.frameId) generation=\(ack.surfaceGeneration) compositorMs=\(Self.formatDouble(ack.compositorMs)) stale=\(ack.staleDiscardCount)")
                    }
                    let resetRequest = await MainActor.run { [weak self] in
                        self?.sink?.consumePendingGraphicsResetRequest()
                    }
                    if let resetRequest {
                        await sendResetRequest(resetRequest)
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                let request = await MainActor.run { [weak self] in
                    self?.sink?.currentGraphicsResetRequest(reason: "graphics-stream-\(String(describing: error))")
                }
                if let request {
                    await onFallbackResetRequest(request)
                    ownedMediaStderrTrace("graphics-reset-request-fallback reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=receive-failed")
                }
                logger.error("owned graphics quic receive failed: \(String(describing: error), privacy: .public)")
                connection.cancel()
                self.connection = nil
                onDisconnected("receive-failed")
                return
            }
        }
    }

    private func receiveReady(
        expectedSessionId: String,
        on connection: NWConnection
    ) async throws -> GraphicsChannelReady {
        let data = try await receive(on: connection)
        let ready = try JSONDecoder().decode(GraphicsChannelReady.self, from: data)
        return try ClientGraphicsChannelHandshake.validateReady(ready, expectedSessionId: expectedSessionId)
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

    private func receive(on connection: NWConnection, maximumLength: Int = 4_096) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) { data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data, !data.isEmpty {
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

    private static func makeReliableQuicParameters(alpn: String) -> NWParameters {
        let options = NWProtocolQUIC.Options(alpn: [alpn])
        options.direction = .bidirectional
        options.isDatagram = false
        #if DEBUG
        sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, _, complete in
            complete(true)
        }, DispatchQueue.main)
        #endif
        return NWParameters(quic: options)
    }

    private static func formatDouble(_ value: Double) -> String {
        String(format: "%.1f", value)
    }
}

final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    private static let quicALPN = "agentdesk-owned-media"
    private static let maxQuicDatagramBytes = 1_200
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.client.owned-media-quic")
    private let lifecycleLock = NSLock()
    private let graphicsReconnectPolicy = GraphicsReconnectPolicy(
        initialDelayMs: Config.graphicsReconnectInitialDelayMs,
        maxDelayMs: Config.graphicsReconnectMaxDelayMs,
        maxAttempts: Config.graphicsReconnectMaxAttempts
    )
    private let host: String
    private let port: UInt16
    private let graphicsPort: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private var connection: NWConnection?
    private var graphicsTransport: OwnedGraphicsTransport?
    private var graphicsTask: Task<Void, Never>?
    private var graphicsReconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?
    private var isStopped = false
    private var graphicsReconnectGeneration: UInt64 = 0
    private var graphicsReconnectAttempt = 0
    private var graphicsReconnectScheduled = false

    init(
        host: String,
        port: UInt16,
        graphicsPort: UInt16 = Config.graphicsPort,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant
    ) {
        self.host = host
        self.port = port
        self.graphicsPort = graphicsPort
        self.active = active
        self.mediaCapability = mediaCapability
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        guard let sink = videoSink as? any OwnedMediaFrameSink else {
            throw MediaTransportError.notYetImplemented
        }
        lifecycleLock.withLock {
            isStopped = false
            graphicsReconnectGeneration &+= 1
            graphicsReconnectAttempt = 0
            graphicsReconnectScheduled = false
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
            ownedMediaStderrTrace("state \(String(describing: state))")
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
        startGraphicsChannel()
        receiveTask = Task { [weak self, connection] in
            await self?.receiveLoop(connection: connection, key: key)
        }
    }

    func stop() {
        lifecycleLock.withLock {
            isStopped = true
            graphicsReconnectGeneration &+= 1
            graphicsReconnectAttempt = 0
            graphicsReconnectScheduled = false
        }
        graphicsTask?.cancel()
        graphicsTask = nil
        graphicsReconnectTask?.cancel()
        graphicsReconnectTask = nil
        graphicsTransport?.stop()
        graphicsTransport = nil
        receiveTask?.cancel()
        receiveTask = nil
        connection?.cancel()
        connection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func startGraphicsChannel() {
        let generation = nextGraphicsLifecycleGeneration()
        guard let generation else { return }
        graphicsTask?.cancel()
        graphicsTransport?.stop()
        graphicsReconnectTask?.cancel()
        graphicsReconnectTask = nil
        let transport = OwnedGraphicsTransport(
            plan: ClientGraphicsConnectionPlan(host: host, port: graphicsPort),
            active: active,
            mediaCapability: mediaCapability,
            sink: sink,
            onFallbackResetRequest: { [weak self] request in
                await self?.sendGraphicsResetFallback(request)
            },
            onDisconnected: { [weak self] reason in
                self?.scheduleGraphicsReconnect(reason: reason, generation: generation)
            }
        )
        graphicsTransport = transport
        graphicsTask = Task { [weak self, transport] in
            do {
                try await transport.start()
                self?.noteGraphicsConnected(generation: generation)
            } catch is CancellationError {
                return
            } catch {
                self?.logger.error("owned graphics quic connect failed: \(String(describing: error), privacy: .public)")
                ownedMediaStderrTrace("graphics-reconnect-failed error=\(String(describing: error))")
                self?.scheduleGraphicsReconnect(reason: "connect-failed", generation: generation)
            }
        }
    }

    private func nextGraphicsLifecycleGeneration() -> UInt64? {
        lifecycleLock.withLock {
            guard !isStopped else { return nil }
            graphicsReconnectGeneration &+= 1
            graphicsReconnectScheduled = false
            return graphicsReconnectGeneration
        }
    }

    private func noteGraphicsConnected(generation: UInt64) {
        lifecycleLock.withLock {
            guard generation == graphicsReconnectGeneration else { return }
            graphicsReconnectAttempt = 0
            graphicsReconnectScheduled = false
        }
    }

    private func nextReconnectDelay(reason: String, generation: UInt64) -> (attempt: Int, delayMs: Int)? {
        lifecycleLock.withLock {
            guard !isStopped,
                  connection != nil,
                  generation == graphicsReconnectGeneration,
                  !graphicsReconnectScheduled else {
                return nil
            }
            let nextAttempt = graphicsReconnectAttempt + 1
            guard let delayMs = graphicsReconnectPolicy.delayMs(forAttempt: nextAttempt) else {
                logger.error("owned graphics reconnect stopped reason=\(reason, privacy: .public) attempts=\(self.graphicsReconnectAttempt, privacy: .public)")
                ownedMediaStderrTrace("graphics-reconnect-stopped reason=\(reason) attempts=\(self.graphicsReconnectAttempt)")
                return nil
            }
            graphicsReconnectAttempt = nextAttempt
            graphicsReconnectScheduled = true
            return (nextAttempt, delayMs)
        }
    }

    private func scheduleGraphicsReconnect(reason: String, generation: UInt64) {
        guard let plan = nextReconnectDelay(reason: reason, generation: generation) else { return }
        logger.notice("owned graphics reconnecting reason=\(reason, privacy: .public) attempt=\(plan.attempt, privacy: .public) delayMs=\(plan.delayMs, privacy: .public)")
        ownedMediaStderrTrace("graphics-reconnecting reason=\(reason) attempt=\(plan.attempt) delayMs=\(plan.delayMs)")
        let task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(plan.delayMs) * 1_000_000)
            guard let self, !Task.isCancelled else { return }
            let canReconnect = self.lifecycleLock.withLock {
                guard generation == self.graphicsReconnectGeneration,
                      !self.isStopped,
                      self.connection != nil else {
                    return false
                }
                self.graphicsReconnectScheduled = false
                self.graphicsReconnectTask = nil
                return true
            }
            guard canReconnect else { return }
            self.startGraphicsChannel()
        }
        lifecycleLock.withLock {
            if !isStopped,
               generation == graphicsReconnectGeneration,
               graphicsReconnectScheduled {
                graphicsReconnectTask = task
            } else {
                task.cancel()
            }
        }
    }

    private func sendGraphicsResetFallback(_ request: OwnedGraphicsResetRequest) async {
        guard let connection else {
            ownedMediaStderrTrace("graphics-reset-fallback-dropped reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=no-media-connection")
            return
        }
        let message = OwnedMediaControlMessage(
            kind: .graphicsResetRequest,
            frameId: request.lastCommittedFrameId,
            graphicsSurfaceGeneration: request.lastCommittedSurfaceGeneration,
            reason: request.reason
        )
        do {
            let data = try JSONEncoder().encode(message)
            try await send(data, on: connection)
            ownedMediaStderrTrace("graphics-reset-fallback reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId)")
        } catch {
            ownedMediaStderrTrace("graphics-reset-fallback-failed reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) error=\(String(describing: error))")
        }
    }

    private func receiveLoop(connection: NWConnection, key: SymmetricKey) async {
        let repairDeadlineNs = UInt64(Config.ownedMediaRepairDeadlineMs) * 1_000_000
        let repairBuffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: repairDeadlineNs,
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
        var skippedStaleFrames = 0
        var keyframeFallbacks = 0
        var lastRepairSnapshot = repairBuffer.debugSnapshot
        while !Task.isCancelled {
            do {
                let data = try await receive(on: connection)
                let packet = try MediaDatagramFramePacket.decode(data, key: key)
                let now = DispatchTime.now().uptimeNanoseconds
                receivedPackets += 1
                if receivedPackets == 1 || receivedPackets.isMultiple(of: 600) {
                    logger.notice("owned media quic received packet count=\(receivedPackets, privacy: .public) frame=\(packet.frameId, privacy: .public) index=\(packet.packetIndex, privacy: .public)/\(packet.packetCount, privacy: .public) bytes=\(data.count, privacy: .public)")
                    ownedMediaStderrTrace("packet count=\(receivedPackets) frame=\(packet.frameId) index=\(packet.packetIndex)/\(packet.packetCount) key=\(packet.isKeyframe) bytes=\(data.count) complete=\(completedFrames) repaired=\(repairedFrames) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) staleSkip=\(skippedStaleFrames) fallback=\(keyframeFallbacks)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("quic packets=\(receivedPackets) frame=\(packet.frameId) index=\(packet.packetIndex)/\(packet.packetCount)\ncomplete=\(completedFrames) repaired=\(repairedFrames) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) staleSkip=\(skippedStaleFrames) fallback=\(keyframeFallbacks)")
                    }
                }
                let repair = repairBuffer.accept(packet, now: now)
                let repairSnapshot = repairBuffer.debugSnapshot
                lastRepairSnapshot = repairSnapshot
                for request in repair.resendRequests {
                    resendRequests += 1
                    resendPackets += request.packetIndexes.count
                    logger.notice("owned media quic packet-resend-request frame=\(request.frameId, privacy: .public) missing=\(request.packetIndexes.count, privacy: .public)")
                    ownedMediaStderrTrace("resend-request frame=\(request.frameId) missing=\(request.packetIndexes.count) firstSeenAgeMs=\(Self.formatMilliseconds(request.firstSeenAgeNs)) indexes=\(Self.formatPacketIndexes(request.packetIndexes)) total=\(resendRequests)/\(resendPackets) \(repairSnapshot.traceFields)")
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
                    ownedMediaStderrTrace("expired-keyframe frame=\(droppedFrame.frameId) received=\(droppedFrame.received)/\(droppedFrame.expected) missing=\(droppedFrame.missingIndexes.count) firstSeenAgeMs=\(Self.formatMilliseconds(droppedFrame.firstSeenAgeNs)) repairAgeMs=\(Self.formatOptionalMilliseconds(droppedFrame.repairAgeNs)) indexes=\(Self.formatPacketIndexes(droppedFrame.missingIndexes)) expired=\(expiredFrames) fallback=\(keyframeFallbacks) \(repairSnapshot.traceFields)")
                    if keyframeRecovery.noteIncompleteFrame(now: now) {
                        try? await sendKeyframeRequest(afterFrameId: droppedFrame.frameId, on: connection)
                    }
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("expired frame=\(droppedFrame.frameId) received=\(droppedFrame.received)/\(droppedFrame.expected) missing=\(droppedFrame.missingIndexes.count)\nquic packets=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) fallback=\(keyframeFallbacks)")
                    }
                }
                for skippedFrame in repair.skippedStaleFrames {
                    skippedStaleFrames += 1
                    ownedMediaStderrTrace("skip-stale-delta frame=\(skippedFrame.frameId) received=\(skippedFrame.received)/\(skippedFrame.expected) missing=\(skippedFrame.missingIndexes.count) firstSeenAgeMs=\(Self.formatMilliseconds(skippedFrame.firstSeenAgeNs)) repairAgeMs=\(Self.formatOptionalMilliseconds(skippedFrame.repairAgeNs)) indexes=\(Self.formatPacketIndexes(skippedFrame.missingIndexes)) staleSkip=\(skippedStaleFrames) \(repairSnapshot.traceFields)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("skip stale frame=\(skippedFrame.frameId) received=\(skippedFrame.received)/\(skippedFrame.expected) missing=\(skippedFrame.missingIndexes.count)\nquic packets=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) staleSkip=\(skippedStaleFrames)")
                    }
                }
                repairedFrames += repair.repairedFrameCount
                for (completedIndex, completed) in repair.completedFrames.enumerated() {
                    let remainingCompletedFrames = max(0, repair.completedFrames.count - completedIndex - 1)
                    let remainingCompletedBytes = repair.completedFrames
                        .dropFirst(completedIndex + 1)
                        .reduce(0) { $0 + $1.data.count }
                    let frameCompleteNs = DispatchTime.now().uptimeNanoseconds
                    let envelope = try OwnedMediaFrameEnvelope.decode(completed.data)
                    if keyframeRecovery.isAwaitingKeyframe, !envelope.header.isKeyframe {
                        skippedDeltasWaitingForKeyframe += 1
                        if skippedDeltasWaitingForKeyframe == 1 || skippedDeltasWaitingForKeyframe.isMultiple(of: 30) {
                            logger.notice("owned media quic skipped delta while waiting for keyframe count=\(skippedDeltasWaitingForKeyframe, privacy: .public) frame=\(envelope.header.frameId, privacy: .public)")
                            ownedMediaStderrTrace("skip-delta-waiting-keyframe count=\(skippedDeltasWaitingForKeyframe) frame=\(envelope.header.frameId) fallback=\(keyframeFallbacks)")
                            if keyframeRecovery.noteSkippedDelta(now: now) {
                                try? await sendKeyframeRequest(afterFrameId: envelope.header.frameId, on: connection)
                            }
                        }
                        continue
                    }
                    if envelope.header.isKeyframe {
                        keyframeRecovery.noteKeyframe()
                        skippedDeltasWaitingForKeyframe = 0
                    }
                    if completed.wasRepaired,
                       !envelope.header.isKeyframe,
                       completed.firstSeenAgeNs >= repairDeadlineNs {
                        skippedStaleFrames += 1
                        ownedMediaStderrTrace("skip-late-repaired-delta frame=\(completed.frameId) ageMs=\(Self.formatMilliseconds(completed.firstSeenAgeNs)) repairedAfterMs=\(Self.formatOptionalMilliseconds(completed.repairedAfterNs)) bytes=\(completed.data.count) packets=\(completed.packetCount) staleSkip=\(skippedStaleFrames) \(repairSnapshot.traceFields)")
                        await MainActor.run { [weak self] in
                            self?.sink?.setOwnedMediaDebugStatus("skip late repaired delta frame=\(completed.frameId) ageMs=\(Self.formatMilliseconds(completed.firstSeenAgeNs)) packets=\(completed.packetCount)\nquic=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) staleSkip=\(skippedStaleFrames)")
                        }
                        continue
                    }
                    completedFrames += 1
                    if completedFrames == 1 || completedFrames.isMultiple(of: 60) || completed.wasRepaired {
                        logger.notice("owned media quic completed frame count=\(completedFrames, privacy: .public) frame=\(completed.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) repaired=\(completed.wasRepaired, privacy: .public) bytes=\(completed.data.count, privacy: .public) packets=\(completed.packetCount, privacy: .public)")
                        ownedMediaStderrTrace("complete count=\(completedFrames) frame=\(completed.frameId) key=\(envelope.header.isKeyframe) repaired=\(completed.wasRepaired) ageMs=\(Self.formatMilliseconds(completed.firstSeenAgeNs)) repairedAfterMs=\(Self.formatOptionalMilliseconds(completed.repairedAfterNs)) bytes=\(completed.data.count) packets=\(completed.packetCount) completedQueueFrames=\(remainingCompletedFrames) completedQueueBytes=\(remainingCompletedBytes) quic=\(receivedPackets) drops=\(droppedPackets) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) staleSkip=\(skippedStaleFrames) fallback=\(keyframeFallbacks) \(repairSnapshot.traceFields)")
                        await MainActor.run { [weak self] in
                            self?.sink?.setOwnedMediaDebugStatus("completed=\(completedFrames) frame=\(completed.frameId) key=\(envelope.header.isKeyframe) repaired=\(repairedFrames) packets=\(completed.packetCount)\nquic=\(receivedPackets) malformed=\(droppedPackets) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) staleSkip=\(skippedStaleFrames) fallback=\(keyframeFallbacks)")
                        }
                    }
                    let renderRequestNs = DispatchTime.now().uptimeNanoseconds
                    let renderStats = await MainActor.run { [weak self] in
                        self?.sink?.renderOwnedMediaFrame(envelope)
                    }
                    if let renderStats {
                        let ackSendStartNs = DispatchTime.now().uptimeNanoseconds
                        do {
                            try await sendFrameAck(renderStats, on: connection)
                            let ackSendEndNs = DispatchTime.now().uptimeNanoseconds
                            let timeline = OwnedMediaFrameTimeline(
                                frameId: completed.frameId,
                                isKeyframe: envelope.header.isKeyframe,
                                wasRepaired: completed.wasRepaired,
                                packetCount: completed.packetCount,
                                payloadBytes: envelope.payload.count,
                                firstPacketToCompleteMs: Self.milliseconds(completed.firstSeenAgeNs),
                                completeToRenderStartMs: Self.milliseconds(renderStats.renderStartUptimeNs &- frameCompleteNs),
                                mainActorWaitMs: Self.milliseconds(renderStats.renderStartUptimeNs &- renderRequestNs),
                                sampleBuildMs: renderStats.sampleBuildMs,
                                enqueueMs: renderStats.enqueueMs,
                                renderWorkMs: renderStats.renderWorkMs,
                                ackSendMs: Self.milliseconds(ackSendEndNs &- ackSendStartNs),
                                completeToAckSentMs: Self.milliseconds(ackSendEndNs &- frameCompleteNs),
                                displayReadyBeforeEnqueue: renderStats.displayReadyBeforeEnqueue,
                                requiresFlushToResumeDecoding: renderStats.requiresFlushToResumeDecoding,
                                displayReadyAfterEnqueue: renderStats.displayReadyAfterEnqueue,
                                requiresFlushAfterEnqueue: renderStats.requiresFlushAfterEnqueue,
                                displayQueueAction: renderStats.displayQueueAction,
                                displayStatus: renderStats.displayStatus,
                                displayStatusAfterEnqueue: renderStats.displayStatusAfterEnqueue,
                                displayPresentation: renderStats.displayPresentation,
                                completedNotRenderedFrames: remainingCompletedFrames,
                                completedNotRenderedBytes: remainingCompletedBytes
                            )
                            ownedMediaStderrTrace(timeline.traceLine)
                        } catch {
                            ownedMediaStderrTrace("frame-ack-failed frame=\(renderStats.frameId) error=\(String(describing: error))")
                        }
                    }
                    let resetRequest = await MainActor.run { [weak self] in
                        self?.sink?.consumePendingGraphicsResetRequest()
                    }
                    if let resetRequest {
                        await graphicsTransport?.sendResetRequest(resetRequest)
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
                    ownedMediaStderrTrace("drop-malformed count=\(droppedPackets) reason=\(error.debugSummary) quic=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) staleSkip=\(skippedStaleFrames) fallback=\(keyframeFallbacks) \(lastRepairSnapshot.traceFields)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("\(error.debugSummary)\ndrops=\(droppedPackets) quic=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) fallback=\(keyframeFallbacks)")
                    }
                }
                continue
            } catch {
                logger.error("owned media quic receive failed: \(String(describing: error), privacy: .public)")
                ownedMediaStderrTrace("receive-failed error=\(String(describing: error)) quic=\(receivedPackets) complete=\(completedFrames) repaired=\(repairedFrames) resend=\(resendRequests)/\(resendPackets) expired=\(expiredFrames) staleSkip=\(skippedStaleFrames) fallback=\(keyframeFallbacks) \(lastRepairSnapshot.traceFields)")
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
        ownedMediaStderrTrace("keyframe-request after=\(frameId)")
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

    private func sendFrameAck(_ stats: OwnedMediaRenderStats, on connection: NWConnection) async throws {
        let message = OwnedMediaControlMessage(
            kind: .frameAck,
            frameId: stats.frameId,
            totalFramesDecoded: stats.totalFramesDecoded,
            renderGapMs: stats.renderGapMs,
            clientBacklogFrames: stats.clientBacklogFrames,
            clientBacklogBytes: stats.clientBacklogBytes
        )
        let data = try JSONEncoder().encode(message)
        try await send(data, on: connection)
        ownedMediaStderrTrace("frame-ack frame=\(stats.frameId) total=\(stats.totalFramesDecoded) renderGapMs=\(Self.formatOptionalDouble(stats.renderGapMs)) sampleMs=\(Self.formatDouble(stats.sampleBuildMs)) enqueueMs=\(Self.formatDouble(stats.enqueueMs)) workMs=\(Self.formatDouble(stats.renderWorkMs)) ready=\(stats.displayReadyBeforeEnqueue) requiresFlush=\(stats.requiresFlushToResumeDecoding) postReady=\(stats.displayReadyAfterEnqueue) postRequiresFlush=\(stats.requiresFlushAfterEnqueue) action=\(stats.displayQueueAction.rawValue) backlogFrames=\(stats.clientBacklogFrames) backlogBytes=\(stats.clientBacklogBytes) flushed=\(stats.flushCount) display=\(stats.displayStatus) postDisplay=\(stats.displayStatusAfterEnqueue) displayPresentation=\(stats.displayPresentation)")
    }

    private static func formatPacketIndexes(_ indexes: [UInt16], limit: Int = 16) -> String {
        let prefix = indexes.prefix(limit).map { String($0) }.joined(separator: ",")
        if indexes.count > limit {
            return "[\(prefix),...+\(indexes.count - limit)]"
        }
        return "[\(prefix)]"
    }

    private static func formatMilliseconds(_ ns: UInt64) -> String {
        String(format: "%.1f", milliseconds(ns))
    }

    private static func milliseconds(_ ns: UInt64) -> Double {
        Double(ns) / 1_000_000.0
    }

    private static func formatOptionalMilliseconds(_ ns: UInt64?) -> String {
        guard let ns else { return "nil" }
        return formatMilliseconds(ns)
    }

    private static func formatOptionalDouble(_ value: Double?) -> String {
        guard let value else { return "nil" }
        return formatDouble(value)
    }

    private static func formatDouble(_ value: Double) -> String {
        String(format: "%.1f", value)
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
