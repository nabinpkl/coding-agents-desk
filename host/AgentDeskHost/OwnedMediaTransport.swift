import CoreMedia
import CoreVideo
import CryptoKit
import Compression
import CoreImage
import Foundation
import Network
import Security
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
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer
    private let graphicsAuthorizer: OwnedGraphicsChannelAuthorizer
    private let scrollActivityHintProvider: @Sendable () -> ScrollActivityHint?

    init(
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer,
        graphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer,
        scrollActivityHintProvider: @escaping @Sendable () -> ScrollActivityHint? = { nil }
    ) {
        self.configuration = configuration
        self.authorizer = authorizer
        self.graphicsAuthorizer = graphicsAuthorizer
        self.scrollActivityHintProvider = scrollActivityHintProvider
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            configuration: configuration,
            authorizer: authorizer,
            graphicsAuthorizer: graphicsAuthorizer,
            scrollActivityHintProvider: scrollActivityHintProvider
        )
    }
}

struct OwnedMediaEncodingConfiguration: Equatable, Sendable {
    let targetBitrateKbps: Int
    let expectedFrameRate: Int
    let keyframeIntervalFrames: Int

    static let `default` = OwnedMediaEncodingConfiguration(
        targetBitrateKbps: Config.ownedMediaBitrateKbps,
        expectedFrameRate: 30,
        keyframeIntervalFrames: 120
    )

    static func fromConfig() -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(
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

final class OwnedMediaHostDiagnostics: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let lock = NSLock()
    private var phase: OwnedMediaPipelinePhase = .idle
    private var fpsWindow = OwnedMediaDiagnosticsFpsWindow(windowStartedAtUptimeNs: DispatchTime.now().uptimeNanoseconds)
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

    func noteAdmissionHold(reason: String?) {
        setPhase(.admissionHold)
        logger.notice("owned media admission-hold-diagnostic reason=\(reason ?? "unknown", privacy: .public)")
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
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer
    private let graphicsAuthorizer: OwnedGraphicsChannelAuthorizer
    private let scrollActivityHintProvider: @Sendable () -> ScrollActivityHint?
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-quic")
    private let lock = NSLock()
    private var graphicsListener: NWListener?
    private var graphicsConnections: [ObjectIdentifier: NWConnection] = [:]
    private var graphicsChannels: [ObjectIdentifier: OwnedGraphicsChannelServer] = [:]
    private var latestPendingGraphicsConnectionId: ObjectIdentifier?
    private var activeGraphicsConnectionId: ObjectIdentifier?
    private var videoSource: VideoFrameSource?
    private var frameMailbox: LatestCapturedFrameMailbox?
    private var encodePumpTask: Task<Void, Never>?
    private var graphicsBackpressure = GraphicsBackpressure(maxUnacked: Config.hybridMaxUnackedFrames)
    private var pendingGraphicsResetRequest: OwnedGraphicsResetRequest?
    private var graphicsRecoveryState: HybridGraphicsRecoveryState = .idle
    private let graphicsAckWaiter = OwnedGraphicsAckWaiter()
    private var diagnostics = OwnedMediaHostDiagnostics()
    private let frameScaler = OwnedMediaFrameScaler()
    private var started = false

    init(
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer,
        graphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer,
        scrollActivityHintProvider: @escaping @Sendable () -> ScrollActivityHint? = { nil }
    ) {
        self.configuration = configuration
        self.authorizer = authorizer
        self.graphicsAuthorizer = graphicsAuthorizer
        self.scrollActivityHintProvider = scrollActivityHintProvider
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
        started = false
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
        graphicsListener?.cancel()
        graphicsConnections.forEach { $0.cancel() }
        graphicsChannels.forEach { $0.close() }
        graphicsAckWaiter.reset()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
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
        var scrollDeltaEngine = ScrollDeltaEngine(
            maxDecodedResetStripePayloadBytes: Config.hybridResetStripeMaxDecodedBytes,
            maxWireResetStripeBytes: Config.hybridResetStripeMaxWireBytes
        )
        // Congestion signal for adaptive fullframe quality: how many frames were
        // held at the unacked cap since the last one was produced. A non-zero count
        // means the link could not drain the last frame before the next arrived (a
        // hard flick flooding fullframes), so the next produce encodes at the
        // congested floor to keep cadence. Reset to 0 each time we produce.
        var heldSinceLastProduce = 0
        // Smoothed congestion level in [0,1]. The raw held count is mapped to an
        // instantaneous level and EWMA-smoothed so the encode quality ramps instead
        // of cliffing to the floor on a single held frame.
        var congestionLevelEwma = 0.0
        for await _ in mailbox.stream {
            guard !Task.isCancelled else { return }
            diagnostics.setPhase(.idle)
            guard let frame = mailbox.takeLatest() else { continue }

            // Single reliable media path: the damage-driven graphics channel.
            // Without an active graphics channel there is nothing to send, so the
            // frame is dropped. There is no HEVC encoder and no datagram channel
            // to fall through to.
            guard let graphicsChannel = latestGraphicsChannel() else {
                diagnostics.noteAdmissionHold(reason: "graphics-disconnected")
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
                diagnostics.noteAdmissionHold(reason: "backpressure-cap")
                logger.notice("owned graphics backpressure-hold reason=unacked-cap maxUnacked=\(Config.hybridMaxUnackedFrames, privacy: .public)")
                heldSinceLastProduce += 1
                continue
            }
            let nowBeforeProbe = DispatchTime.now().uptimeNanoseconds
            let inputScrollHint = scrollActivityHintProvider()
            let scrollHint = inputScrollHint?.isActive(nowUptimeNs: nowBeforeProbe) == true
                ? inputScrollHint
                : nil
            // Map held frames to an instantaneous congestion level and EWMA-smooth it,
            // so the encode quality and resolution ramp with sustained backpressure
            // instead of cliffing on the first held frame.
            let instantaneousCongestion = min(1.0, Double(heldSinceLastProduce) / Double(Config.hybridCongestionSaturationHolds))
            congestionLevelEwma = Config.hybridCongestionEwmaAlpha * instantaneousCongestion
                + (1 - Config.hybridCongestionEwmaAlpha) * congestionLevelEwma
            heldSinceLastProduce = 0
            let graphics = scrollDeltaEngine.evaluate(frame, scrollHint: scrollHint, congestionLevel: congestionLevelEwma)
            switch graphics.kind {
            case .accepted:
                guard let envelope = graphics.envelope else {
                    diagnostics.noteAdmissionHold(reason: "graphics-accepted-no-envelope")
                    continue
                }
                do {
                    let encodedBytes = try await graphicsChannel.send(envelope)
                    noteGraphicsFrameSent(envelope, encodedBytes: encodedBytes)
                    scrollDeltaEngine.commitPendingSurface()
                    // Content tile cache decisions for this frame: cacheStores is rung 3
                    // (cacheTile, pixels sent and a slot stored); cacheHits is rung 2
                    // (drawCachedTile, the client already holds the content so zero pixel
                    // bytes go on the wire). Rung 1 omits a cell entirely, so it never
                    // appears as a command and is visible only as a lower command count.
                    var cacheStores = 0
                    var cacheHits = 0
                    for command in envelope.commands {
                        switch command {
                        case .cacheTile: cacheStores += 1
                        case .drawCachedTile: cacheHits += 1
                        default: break
                        }
                    }
                    logger.notice("owned graphics accepted frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) commands=\(envelope.commands.count, privacy: .public) payloadBytes=\(envelope.payload.count, privacy: .public) cacheStores=\(cacheStores, privacy: .public) cacheHits=\(cacheHits, privacy: .public) acceptedBy=\(graphics.diagnostics?.acceptedBy ?? "unknown", privacy: .public) decision=\(graphics.diagnostics?.timeoutReason ?? "none", privacy: .public) confidence=\(graphics.diagnostics?.confidence ?? 0, privacy: .public) hintActive=\(graphics.diagnostics?.hintActive ?? false, privacy: .public) hintAxis=\(graphics.diagnostics?.hintAxis ?? "none", privacy: .public)")
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
                        // Tolerate a slow link: re-wait for the stripe ack, checking
                        // the connection each round, instead of closing on the first
                        // timeout. Closing would re-sync the whole surface and make a
                        // slow link worse (the freeze cascade). A genuinely dead
                        // channel still aborts within one timeout (connection goes
                        // inactive); only a truly stuck ack hits the full grace.
                        var ackAttempt = 0
                        while true {
                            if await graphicsAckWaiter.wait(
                                for: envelope.header.updateId,
                                timeoutMs: Config.hybridResetStripeAckTimeoutMs
                            ) {
                                logger.notice("owned graphics reset-stripe-ack frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) stripe=\(index + 1, privacy: .public) stripes=\(envelopes.count, privacy: .public)")
                                break
                            }
                            if !isActiveGraphicsConnection(resetConnectionId) {
                                logger.notice("owned graphics reset wait abandoned reason=stale-channel frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public)")
                                throw OwnedGraphicsResetSendError.staleChannel(envelope.header.updateId)
                            }
                            ackAttempt += 1
                            if ackAttempt >= Config.hybridResetStripeAckMaxAttempts {
                                throw OwnedGraphicsResetSendError.ackTimeout(envelope.header.updateId)
                            }
                            logger.notice("owned graphics reset-stripe-ack-slow frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) attempt=\(ackAttempt, privacy: .public) maxAttempts=\(Config.hybridResetStripeAckMaxAttempts, privacy: .public)")
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
                diagnostics.noteAdmissionHold(reason: "graphics-damage-nochange")
                continue
            case .timeout, .rejected:
                // The damage path does not return these now. There is no HEVC
                // fallback; hold the frame.
                diagnostics.noteAdmissionHold(reason: "graphics-no-update")
                continue
            }
        }
    }

    private static func pixelSize(_ pixelBuffer: CVPixelBuffer) -> CapturePixelSize {
        CapturePixelSize(
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer)
        )
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

