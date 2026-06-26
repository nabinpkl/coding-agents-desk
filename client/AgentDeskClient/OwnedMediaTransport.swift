import Foundation
import Network
import OSLog
import Security

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let host: String
    private let graphicsPort: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private let mediaCapabilityRefresher: MediaCapabilityRefreshing?

    init(
        host: String,
        graphicsPort: UInt16 = Config.graphicsPort,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        mediaCapabilityRefresher: MediaCapabilityRefreshing?
    ) {
        self.host = host
        self.graphicsPort = graphicsPort
        self.active = active
        self.mediaCapability = mediaCapability
        self.mediaCapabilityRefresher = mediaCapabilityRefresher
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            host: host,
            graphicsPort: graphicsPort,
            active: active,
            mediaCapability: mediaCapability,
            mediaCapabilityRefresher: mediaCapabilityRefresher
        )
    }
}

final class OwnedGraphicsTransport: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "owned-graphics")
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.client.owned-graphics-quic")
    private let plan: ClientGraphicsConnectionPlan
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private var group: NWConnectionGroup?
    // ADR-0025 motion carrier: a dedicated isDatagram QUIC connection to the host's
    // datagram listener, carrying the HEVC video (host -> client) and keyframe requests
    // (client -> host). nil when the carrier flag is off.
    private var videoDatagramConnection: NWConnection?
    // ADR-0025 motion carrier: the group that drives the carrier connection's QUIC
    // handshake. A bare client NWConnection to a QUIC listener never initiates the
    // handshake (see start()); the group drives it, then vends the member connection.
    private var videoDatagramGroup: NWConnectionGroup?
    private var connection: NWConnection?
    private var controlConnection: NWConnection?
    private var pendingConnection: NWConnection?
    private var pendingControlConnection: NWConnection?
    private var pendingResetRequest: OwnedGraphicsResetRequest?
    private let resetFallbackLock = NSLock()
    private var resetFallbackGate = OwnedGraphicsResetFallbackGate()
    private var receiveTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?
    // ADR-0025 motion carrier receive state. The repair buffer reassembles the HEVC
    // datagram stream under loss; it is only touched from the group's receive handler,
    // which runs serialized on `queue`. The key matches the host's shared constant
    // (QUIC already secures the channel).
    private static let videoDatagramKey = MediaDatagramCrypto.key(
        mediaCapability: "owned-hevc-motion",
        clientNonce: Data(),
        serverNonce: Data()
    )
    private lazy var videoRepairBuffer = MediaDatagramFrameRepairBuffer(
        repairDeadlineNs: UInt64(Config.ownedMediaRepairDeadlineMs) * 1_000_000,
        trackedFrameLimit: Config.ownedMediaTrackedFrameLimit,
        maxResendPackets: Config.ownedMediaMaxResendPackets
    )
    // ADR-0025 diagnostic: counts inbound video datagrams so a device run can prove
    // whether the host -> client datagram path delivers at all (the receive handler
    // firing) versus a decode/reassembly fault. Touched only on `queue`.
    private var videoDatagramRxCount = 0
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
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(self.plan.host), port: endpointPort)
        // ADR-0022: ONE QUIC connection (an NWConnectionGroup) carrying two streams.
        // Frames ride the graphics stream; acks and reset-requests ride the
        // interactive stream, so a large frame cannot head-of-line-block control.
        let group = NWConnectionGroup(with: NWMultiplexGroup(to: endpoint), using: Self.makeReliableQuicParameters(alpn: self.plan.alpn))
        self.group = group
        var didStart = false
        defer {
            if !didStart {
                self.group = nil
                self.pendingConnection = nil
                self.pendingControlConnection = nil
                self.pendingResetRequest = nil
                group.cancel()
            }
        }
        // A client NWMultiplexGroup is INERT until a newConnectionHandler is set before
        // start(): without it the group never initiates the QUIC handshake (no state
        // transitions at all) and NWConnection(from:) returns nil forever. With it, the
        // group drives the handshake and reaches .ready on its own; only then can it
        // vend member connections. We never expect server-initiated streams, so accept
        // and drop any. A connection timeout recycles a stalled handshake via the
        // reconnect loop instead of hanging.
        group.newConnectionHandler = { stream in stream.cancel() }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            // The group handler and the timeout both run serialized on self.queue, so
            // this flag is safe; mark it unsafe to satisfy the concurrency checker.
            nonisolated(unsafe) var resumed = false
            group.stateUpdateHandler = { [weak self] state in
                self?.logger.notice("owned graphics quic group state=\(String(describing: state), privacy: .public)")
                switch state {
                case .ready:
                    if !resumed { resumed = true; cont.resume() }
                case .failed(let error):
                    if !resumed { resumed = true; cont.resume(throwing: error) }
                case .cancelled:
                    if !resumed { resumed = true; cont.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            group.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 6) {
                if !resumed { resumed = true; cont.resume(throwing: SessionRejected(reason: .malformed)) }
            }
        }
        // Steady-state group handler: tear the session down if the connection fails.
        group.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned graphics quic group state=\(String(describing: state), privacy: .public)")
            if case .failed = state { self?.onDisconnected("group-failed") }
        }

        // Graphics stream: role 'G' + hello, then ready. (Every app stream is created
        // explicitly; the group's implicit stream 0 is not used.) Now that the group is
        // ready it can vend a member connection; starting it drives stream setup.
        guard let graphics = NWConnection(from: group, to: endpoint) else {
            throw SessionRejected(reason: .malformed)
        }
        self.pendingConnection = graphics
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            // The stream state handler is serialized on `self.queue`, so a plain flag
            // is safe here; mark it unsafe to satisfy the concurrency checker.
            nonisolated(unsafe) var resumed = false
            graphics.stateUpdateHandler = { [weak self] state in
                self?.logger.notice("owned graphics quic stream state=\(String(describing: state), privacy: .public)")
                switch state {
                case .ready:
                    if !resumed { resumed = true; cont.resume() }
                case .failed(let error):
                    if !resumed { resumed = true; cont.resume(throwing: error) }
                case .cancelled:
                    if !resumed { resumed = true; cont.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            graphics.start(queue: self.queue)
        }
        // Steady-state stream handler: drop the gating closure now that it is ready.
        graphics.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned graphics quic stream state=\(String(describing: state), privacy: .public)")
        }
        let hello = ClientGraphicsChannelHandshake.makeHello(
            active: self.active,
            mediaCapability: self.mediaCapability,
            clientNonce: try Self.randomBytes(count: 32)
        )
        try await self.send(Data([OwnedGraphicsStreamRole.graphics.rawValue]) + (try JSONEncoder().encode(hello)), on: graphics)
        _ = try await self.receiveReady(expectedSessionId: self.active.sessionId, on: graphics)

        // Interactive stream: role 'I' only. Trusted as a sibling on the same
        // authenticated QUIC connection; no second hello.
        guard let interactive = NWConnection(from: group, to: endpoint) else {
            throw SessionRejected(reason: .malformed)
        }
        interactive.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned graphics control quic stream state=\(String(describing: state), privacy: .public)")
        }
        interactive.start(queue: self.queue)
        self.pendingControlConnection = interactive
        try await self.send(Data([OwnedGraphicsStreamRole.interactive.rawValue]), on: interactive)

        self.pendingConnection = nil
        self.pendingControlConnection = nil
        self.connection = graphics
        self.controlConnection = interactive
        resetFallbackLock.withLock {
            resetFallbackGate.startConnection()
        }
        if let pendingResetRequest {
            self.pendingResetRequest = nil
            do {
                try await send(OwnedGraphicsControlStreamFrame.encode(pendingResetRequest), on: interactive)
                ownedMediaStderrTrace("graphics-reset-request reason=\(pendingResetRequest.reason) generation=\(pendingResetRequest.lastCommittedSurfaceGeneration) frame=\(pendingResetRequest.lastCommittedFrameId) state=drained-pending")
            } catch {
                logger.error("owned graphics pending reset request failed: \(String(describing: error), privacy: .public)")
                ownedMediaStderrTrace("graphics-reset-request-failed reason=\(pendingResetRequest.reason) generation=\(pendingResetRequest.lastCommittedSurfaceGeneration) frame=\(pendingResetRequest.lastCommittedFrameId) error=\(String(describing: error)) state=drained-pending")
                await sendFallbackResetIfAllowed(pendingResetRequest, state: "drained-pending", marksGenerationFailed: true)
                onDisconnected("reset-send-failed")
                throw error
            }
        }
        // ADR-0025 motion carrier: open the dedicated isDatagram connection for HEVC
        // video once the reliable channel is up. Gated on the flag; off by default, so
        // the daily driver opens only the reliable group.
        startVideoDatagramConnection()
        didStart = true
        self.logger.notice("owned graphics quic ready port=\(Int(self.plan.port), privacy: .public)")
        receiveTask = Task { [weak self, graphics] in
            await self?.receiveFrames(on: graphics)
        }
    }

    // ADR-0025 motion carrier: stand up the client's datagram connection to the host's
    // datagram listener. The receive loop hands inbound video datagrams to the repair
    // buffer; keyframe requests are sent back on the same connection. Failures here do
    // not fail the session, the reliable tile path stays the source of truth.
    private func startVideoDatagramConnection() {
        guard Config.ownedMediaVideoMotionEnabled else { return }
        guard let port = NWEndpoint.Port(rawValue: Config.ownedMediaDatagramPort) else { return }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(self.plan.host), port: port)
        // A bare client NWConnection to a QUIC listener stays INERT: it never initiates
        // the handshake, never reaches .ready, and every host datagram send then fails
        // ENOTCONN (POSIX 57), flooding the host send path until the reliable channel
        // starves and the UI freezes. Drive the carrier handshake through a group exactly
        // like the reliable channel (see start()), then vend a member connection for
        // datagram I/O. A carrier failure is non-fatal: the tile path stays primary.
        let group = NWConnectionGroup(
            with: NWMultiplexGroup(to: endpoint),
            using: Self.makeDatagramQuicParameters(alpn: ClientGraphicsChannelHandshake.datagramALPN)
        )
        self.videoDatagramGroup = group
        group.newConnectionHandler = { stream in stream.cancel() }
        ownedMediaStderrTrace("video-datagram-dial host=\(self.plan.host) port=\(Config.ownedMediaDatagramPort)")
        Task { [weak self] in
            await self?.openVideoDatagramMember(group: group, endpoint: endpoint)
        }
    }

    // Drive the carrier group to .ready (a client group is inert until newConnectionHandler
    // is set before start()), then vend a member connection for datagram send/receive.
    // Bounded by a timeout so a stalled handshake recycles instead of hanging; any failure
    // tears the carrier down but leaves the reliable session alive.
    private func openVideoDatagramMember(group: NWConnectionGroup, endpoint: NWEndpoint) async {
        do {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                nonisolated(unsafe) var resumed = false
                group.stateUpdateHandler = { [weak self] state in
                    self?.logger.notice("owned media datagram group state=\(String(describing: state), privacy: .public)")
                    ownedMediaStderrTrace("video-datagram-group-state state=\(String(describing: state))")
                    switch state {
                    case .ready:
                        if !resumed { resumed = true; cont.resume() }
                    case .failed(let error):
                        if !resumed { resumed = true; cont.resume(throwing: error) }
                    case .cancelled:
                        if !resumed { resumed = true; cont.resume(throwing: CancellationError()) }
                    default:
                        break
                    }
                }
                group.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + 6) {
                    if !resumed { resumed = true; cont.resume(throwing: SessionRejected(reason: .malformed)) }
                }
            }
            // Steady-state group handler now that it is ready.
            group.stateUpdateHandler = { [weak self] state in
                self?.logger.notice("owned media datagram group state=\(String(describing: state), privacy: .public)")
                ownedMediaStderrTrace("video-datagram-group-state state=\(String(describing: state))")
            }
            guard let connection = NWConnection(from: group, to: endpoint) else {
                logger.error("owned media datagram member vend failed")
                ownedMediaStderrTrace("video-datagram-member-vend-failed")
                group.cancel()
                return
            }
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                nonisolated(unsafe) var resumed = false
                connection.stateUpdateHandler = { [weak self] state in
                    self?.logger.notice("owned media datagram connection state=\(String(describing: state), privacy: .public)")
                    ownedMediaStderrTrace("video-datagram-conn-state state=\(String(describing: state))")
                    switch state {
                    case .ready:
                        if !resumed { resumed = true; cont.resume() }
                    case .failed(let error):
                        if !resumed { resumed = true; cont.resume(throwing: error) }
                    case .cancelled:
                        if !resumed { resumed = true; cont.resume(throwing: CancellationError()) }
                    default:
                        break
                    }
                }
                connection.start(queue: self.queue)
            }
            connection.stateUpdateHandler = { [weak self] state in
                self?.logger.notice("owned media datagram connection state=\(String(describing: state), privacy: .public)")
                ownedMediaStderrTrace("video-datagram-conn-state state=\(String(describing: state))")
            }
            self.videoDatagramConnection = connection
            self.receiveVideoDatagram(on: connection)
            logger.notice("owned media datagram carrier ready")
            ownedMediaStderrTrace("video-datagram-carrier-ready")
        } catch {
            logger.error("owned media datagram carrier setup failed: \(String(describing: error), privacy: .public)")
            ownedMediaStderrTrace("video-datagram-carrier-failed error=\(String(describing: error))")
            group.cancel()
        }
    }

    // Inbound datagrams on the carrier connection are host -> client HEVC packets.
    // Re-arm after each so the loop runs for the session.
    private func receiveVideoDatagram(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.handleVideoDatagram(data)
            }
            if error == nil {
                self.receiveVideoDatagram(on: connection)
            }
        }
    }

    func stop() {
        receiveTask?.cancel()
        receiveTask = nil
        self.pendingConnection?.cancel()
        self.pendingConnection = nil
        self.pendingControlConnection?.cancel()
        self.pendingControlConnection = nil
        self.pendingResetRequest = nil
        self.connection?.cancel()
        self.connection = nil
        self.controlConnection?.cancel()
        self.controlConnection = nil
        self.videoDatagramConnection?.cancel()
        self.videoDatagramConnection = nil
        self.videoDatagramGroup?.cancel()
        self.videoDatagramGroup = nil
        self.group?.cancel()
        self.group = nil
    }

    func sendResetRequest(_ request: OwnedGraphicsResetRequest) async {
        guard let controlConnection else {
            if pendingControlConnection != nil {
                pendingResetRequest = request
                ownedMediaStderrTrace("graphics-reset-request-pending reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=pending-connection")
                return
            }
            await sendFallbackResetIfAllowed(request, state: "no-connection", marksGenerationFailed: true)
            onDisconnected("reset-no-connection")
            return
        }
        do {
            try await send(OwnedGraphicsControlStreamFrame.encode(request), on: controlConnection)
            ownedMediaStderrTrace("graphics-reset-request reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId)")
        } catch {
            logger.error("owned graphics reset request failed: \(String(describing: error), privacy: .public)")
            ownedMediaStderrTrace("graphics-reset-request-failed reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) error=\(String(describing: error))")
            await sendFallbackResetIfAllowed(request, state: "reset-send-failed", marksGenerationFailed: true)
            onDisconnected("reset-send-failed")
        }
    }

    private func receiveFrames(on connection: NWConnection) async {
        var framer = OwnedGraphicsStreamFrameParser()
        while !Task.isCancelled {
            do {
                let chunk = try await receive(on: connection, maximumLength: 256 * 1024)
                let frames = try framer.append(chunk)
                for (index, frame) in frames.enumerated() {
                    let queuedFrames = max(0, frames.count - index - 1)
                    let queueDepthBytes = frames.dropFirst(index + 1).reduce(0) { partial, queuedFrame in
                        partial + queuedFrame.wireByteCount
                    }
                    let queueDepth = OwnedGraphicsQueueDepth(
                        queuedFrames: queuedFrames,
                        queueDepthBytes: queueDepthBytes
                    )
                    let ack = await MainActor.run { [weak self] in
                        self?.sink?.renderOwnedGraphicsFrame(frame, queueDepth: queueDepth)
                    }
                    if let ack, let controlConnection = self.controlConnection {
                        // Acks ride the interactive connection so a large frame in
                        // flight on the graphics connection cannot delay them.
                        try await send(OwnedGraphicsControlStreamFrame.encode(ack), on: controlConnection)
                        ownedMediaStderrTrace("graphics-ack frame=\(ack.frameId) generation=\(ack.surfaceGeneration) queuedFrames=\(ack.queuedFrames) queueDepthBytes=\(ack.queueDepthBytes) totalGraphicsApplied=\(ack.totalGraphicsFramesApplied) compositorMs=\(Self.formatDouble(ack.compositorMs)) stale=\(ack.staleDiscardCount)")
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
                    await sendFallbackResetIfAllowed(request, state: "receive-failed", marksGenerationFailed: false)
                }
                logger.error("owned graphics quic receive failed: \(String(describing: error), privacy: .public)")
                connection.cancel()
                self.connection = nil
                // Tear down the sibling interactive stream and the group: a session
                // is the whole connection, so recovery re-establishes the pair.
                self.controlConnection?.cancel()
                self.controlConnection = nil
                self.group?.cancel()
                self.group = nil
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
        if let rejected = try? JSONDecoder().decode(SessionRejected.self, from: data),
           rejected.type == "session-rejected" {
            throw rejected
        }
        do {
            let ready = try JSONDecoder().decode(GraphicsChannelReady.self, from: data)
            return try ClientGraphicsChannelHandshake.validateReady(ready, expectedSessionId: expectedSessionId)
        } catch {
            throw OwnedGraphicsTransportError.controlMalformed
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

    private func receive(on connection: NWConnection, maximumLength: Int = 4_096) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) { data, _, _, error in
                continuation.resume(with: Result { try OwnedGraphicsStreamRead.unwrap(data: data, error: error) })
            }
        }
    }

    private func sendFallbackResetIfAllowed(
        _ request: OwnedGraphicsResetRequest,
        state: String,
        marksGenerationFailed: Bool
    ) async {
        let decision = resetFallbackLock.withLock {
            resetFallbackGate.beginFallbackIfAllowed(for: request)
        }
        guard decision == .send else {
            if case let .suppress(reason) = decision {
                ownedMediaStderrTrace("graphics-reset-request-fallback-suppressed reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=\(state) suppress=\(reason)")
            }
            return
        }

        await onFallbackResetRequest(request)
        resetFallbackLock.withLock {
            if marksGenerationFailed {
                resetFallbackGate.noteFallbackFailed(for: request)
            } else {
                resetFallbackGate.noteFallbackCompleted(for: request)
            }
        }
        ownedMediaStderrTrace("graphics-reset-request-fallback reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=\(state)")
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }

    // ADR-0025: a video datagram arrived. Decode the packet, feed the repair buffer,
    // hand each completed frame to the sink on the main actor, and ask for a keyframe
    // when a frame is dropped past its repair deadline. Runs serialized on `queue`.
    private func handleVideoDatagram(_ data: Data) {
        videoDatagramRxCount &+= 1
        guard let packet = try? MediaDatagramFramePacket.decode(data, key: Self.videoDatagramKey) else {
            if videoDatagramRxCount <= 8 {
                logger.notice("owned media video datagram decode-failed rx=\(self.videoDatagramRxCount, privacy: .public) bytes=\(data.count, privacy: .public)")
            }
            return
        }
        if videoDatagramRxCount <= 8 || videoDatagramRxCount.isMultiple(of: 120) {
            logger.notice("owned media video datagram rx=\(self.videoDatagramRxCount, privacy: .public) frame=\(packet.frameId, privacy: .public) idx=\(packet.packetIndex, privacy: .public)/\(packet.packetCount, privacy: .public) key=\(packet.isKeyframe, privacy: .public) bytes=\(data.count, privacy: .public)")
            ownedMediaStderrTrace("video-datagram-rx rx=\(self.videoDatagramRxCount) frame=\(packet.frameId) idx=\(packet.packetIndex)/\(packet.packetCount) key=\(packet.isKeyframe) bytes=\(data.count)")
        }
        let result = videoRepairBuffer.accept(packet, now: DispatchTime.now().uptimeNanoseconds)
        for completed in result.completedFrames {
            guard let envelope = try? OwnedMediaFrameEnvelope.decode(completed.data) else {
                logger.notice("owned media video frame-complete decode-failed frame=\(completed.frameId, privacy: .public) bytes=\(completed.data.count, privacy: .public)")
                continue
            }
            logger.notice("owned media video frame-complete frame=\(completed.frameId, privacy: .public) bytes=\(completed.data.count, privacy: .public)")
            ownedMediaStderrTrace("video-frame-complete frame=\(completed.frameId) bytes=\(completed.data.count)")
            Task { @MainActor [weak self] in self?.sink?.renderOwnedVideoFrame(envelope) }
        }
        if let expired = result.expiredFrames.last {
            sendVideoControl(OwnedMediaControlMessage(kind: .keyframeRequest, frameId: expired.frameId))
            logger.notice("owned media video keyframe-request frame=\(expired.frameId, privacy: .public) missing=\(expired.missingIndexes.count, privacy: .public)")
        }
    }

    private func sendVideoControl(_ message: OwnedMediaControlMessage) {
        guard let connection = videoDatagramConnection, let data = try? JSONEncoder().encode(message) else { return }
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    private static func makeReliableQuicParameters(alpn: String) -> NWParameters {
        let options = NWProtocolQUIC.Options(alpn: [alpn])
        options.direction = .bidirectional
        options.isDatagram = false
        // The reliable graphics group carries only streams. The motion carrier's
        // datagrams ride a separate isDatagram connection, never this group.
        // ADR-0022: two app streams per connection (plus the group's implicit
        // stream 0). Allow several streams; the default is too small.
        options.initialMaxStreamsBidirectional = 8
        options.initialMaxStreamsUnidirectional = 8
        #if DEBUG
        sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, _, complete in
            complete(true)
        }, DispatchQueue.main)
        #endif
        return NWParameters(quic: options)
    }

    // ADR-0025 motion carrier: parameters for the dedicated datagram connection.
    // isDatagram = true carries QUIC DATAGRAM frames only; maxDatagramFrameSize must be
    // advertised so the host can send them (the host advertises the mirror).
    private static func makeDatagramQuicParameters(alpn: String) -> NWParameters {
        let options = NWProtocolQUIC.Options(alpn: [alpn])
        options.direction = .bidirectional
        options.isDatagram = true
        options.maxDatagramFrameSize = Config.ownedMediaMaxDatagramFrameSize
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

// Graphics-only media transport. The owned-media datagram channel and the HEVC
// decode path were deleted in the damage-driven single-channel collapse, so this
// transport now connects only on the reliable `agentdesk-owned-graphics` channel
// via OwnedGraphicsTransport. It owns the graphics-channel lifecycle: connect,
// capability refresh, and bounded reconnect. There is no second channel, so a
// graphics reset request has nowhere to fall back to and is driven entirely by
// OwnedGraphicsTransport's own pending/reconnect path.
final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: Config.logSubsystem, category: "owned-media")
    private let lifecycleLock = NSLock()
    private let graphicsReconnectPolicy = GraphicsReconnectPolicy(
        initialDelayMs: Config.graphicsReconnectInitialDelayMs,
        maxDelayMs: Config.graphicsReconnectMaxDelayMs,
        maxAttempts: Config.graphicsReconnectMaxAttempts
    )
    private let host: String
    private let graphicsPort: UInt16
    private let active: ActiveSession
    private var mediaCapability: MediaCapabilityGrant
    private let mediaCapabilityRefresher: MediaCapabilityRefreshing?
    private var graphicsTransport: OwnedGraphicsTransport?
    private var graphicsTask: Task<Void, Never>?
    private var graphicsReconnectTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?
    private var isStopped = false
    private var graphicsReconnectGeneration: UInt64 = 0
    private var graphicsReconnectAttempt = 0
    private var graphicsReconnectScheduled = false

    init(
        host: String,
        graphicsPort: UInt16 = Config.graphicsPort,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        mediaCapabilityRefresher: MediaCapabilityRefreshing?
    ) {
        self.host = host
        self.graphicsPort = graphicsPort
        self.active = active
        self.mediaCapability = mediaCapability
        self.mediaCapabilityRefresher = mediaCapabilityRefresher
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
        self.sink = sink
        stateContinuation.yield(.connecting)
        startGraphicsChannel(refreshCapability: false)
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
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func startGraphicsChannel(refreshCapability: Bool) {
        let generation = nextGraphicsLifecycleGeneration()
        guard let generation else { return }
        graphicsTask?.cancel()
        graphicsTransport?.stop()
        graphicsReconnectTask?.cancel()
        graphicsReconnectTask = nil
        graphicsTask = Task { [weak self] in
            guard let self else { return }
            let grant: MediaCapabilityGrant
            do {
                grant = try await self.mediaCapabilityForGraphicsConnect(refreshCapability: refreshCapability)
            } catch is CancellationError {
                return
            } catch {
                self.failMediaTransportAfterCapabilityRefresh(error)
                return
            }
            do {
                guard self.lifecycleLock.withLock({ !self.isStopped && self.graphicsReconnectGeneration == generation }) else {
                    return
                }
                let transport = OwnedGraphicsTransport(
                    plan: ClientGraphicsConnectionPlan(host: self.host, port: self.graphicsPort),
                    active: self.active,
                    mediaCapability: grant,
                    sink: self.sink,
                    onFallbackResetRequest: { request in
                        ownedMediaStderrTrace("graphics-reset-fallback-dropped reason=\(request.reason) generation=\(request.lastCommittedSurfaceGeneration) frame=\(request.lastCommittedFrameId) state=no-fallback-channel")
                    },
                    onDisconnected: { [weak self] reason in
                        self?.scheduleGraphicsReconnect(reason: reason, generation: generation)
                    }
                )
                self.graphicsTransport = transport
                try await transport.start()
                self.noteGraphicsConnected(generation: generation)
                self.stateContinuation.yield(.connected)
            } catch is CancellationError {
                return
            } catch {
                self.logger.error("owned graphics quic connect failed: \(String(describing: error), privacy: .public)")
                ownedMediaStderrTrace("graphics-reconnect-failed error=\(String(describing: error))")
                self.scheduleGraphicsReconnect(reason: "connect-failed", generation: generation)
            }
        }
    }

    private func mediaCapabilityForGraphicsConnect(refreshCapability: Bool) async throws -> MediaCapabilityGrant {
        guard refreshCapability else {
            return lifecycleLock.withLock { mediaCapability }
        }
        guard let mediaCapabilityRefresher else {
            throw SessionRejected(reason: .malformed)
        }
        ownedMediaStderrTrace("graphics-capability-refresh-request session=\(active.sessionId)")
        let refreshed = try await mediaCapabilityRefresher.refreshMediaCapability(
            deviceFingerprint: active.deviceFingerprint,
            sessionId: active.sessionId
        )
        lifecycleLock.withLock {
            mediaCapability = refreshed
        }
        ownedMediaStderrTrace("graphics-capability-refreshed session=\(refreshed.sessionId) expiresAt=\(refreshed.mediaCapabilityExpiresAt)")
        return refreshed
    }

    private func failMediaTransportAfterCapabilityRefresh(_ error: Error) {
        logger.error("owned graphics capability refresh failed: \(String(describing: error), privacy: .public)")
        ownedMediaStderrTrace("graphics-capability-refresh-failed error=\(String(describing: error))")
        lifecycleLock.withLock {
            isStopped = true
            graphicsReconnectGeneration &+= 1
            graphicsReconnectAttempt = 0
            graphicsReconnectScheduled = false
        }
        graphicsReconnectTask?.cancel()
        graphicsReconnectTask = nil
        graphicsTransport?.stop()
        graphicsTransport = nil
        stateContinuation.yield(.failed(error as? SessionRejected))
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
        guard let plan = nextReconnectDelay(reason: reason, generation: generation) else {
            stateContinuation.yield(.failed(nil))
            return
        }
        logger.notice("owned graphics reconnecting reason=\(reason, privacy: .public) attempt=\(plan.attempt, privacy: .public) delayMs=\(plan.delayMs, privacy: .public)")
        ownedMediaStderrTrace("graphics-reconnecting reason=\(reason) attempt=\(plan.attempt) delayMs=\(plan.delayMs)")
        stateContinuation.yield(.disconnected)
        let task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(plan.delayMs) * 1_000_000)
            guard let self, !Task.isCancelled else { return }
            let canReconnect = self.lifecycleLock.withLock {
                guard generation == self.graphicsReconnectGeneration,
                      !self.isStopped else {
                    return false
                }
                self.graphicsReconnectScheduled = false
                self.graphicsReconnectTask = nil
                return true
            }
            guard canReconnect else { return }
            self.startGraphicsChannel(refreshCapability: true)
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
}

private func ownedMediaStderrTrace(_ message: String) {
    guard ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_STDERR_TRACE"] == "1",
          let data = "[owned-media] \(message)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}
