import CoreMedia
import CoreVideo
import CryptoKit
import Compression
import CoreImage
import Foundation
import Network
import Security
import os

typealias OwnedGraphicsChannelAuthorizer = @Sendable (GraphicsChannelHello) async -> MediaCapabilityValidationResult

// A QUIC connection (NWConnectionGroup) still assembling its two streams. The
// client opens the graphics stream (role 'G' + hello) and the interactive stream
// (role 'I', trusted as a sibling). The channel installs once the graphics stream
// has authenticated and the interactive stream has arrived.
private final class PendingGraphicsGroup {
    let group: NWConnectionGroup
    var graphicsStream: NWConnection?
    var interactiveStream: NWConnection?
    var graphicsAuthed = false
    init(group: NWConnectionGroup) { self.group = group }
}

final class OwnedGraphicsChannelServer: @unchecked Sendable {
    // The graphics-stream connection: frames are sent on it and its identity keys
    // the active channel. The interactive-stream connection carries inbound control.
    let connection: NWConnection
    private let controlConnection: NWConnection
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-graphics")
    private let stateQueue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-graphics-state")
    private var closed = false
    private var latestAck: OwnedGraphicsFrameAck?
    private var controlParser = OwnedGraphicsControlStreamFrameParser()
    private let onFrameAck: @Sendable (ObjectIdentifier, OwnedGraphicsFrameAck) -> Void
    private let onResetRequest: @Sendable (OwnedGraphicsResetRequest) -> Void

    init(
        graphicsConnection: NWConnection,
        controlConnection: NWConnection,
        onFrameAck: @escaping @Sendable (ObjectIdentifier, OwnedGraphicsFrameAck) -> Void,
        onResetRequest: @escaping @Sendable (OwnedGraphicsResetRequest) -> Void
    ) {
        self.connection = graphicsConnection
        self.controlConnection = controlConnection
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
        controlConnection.cancel()
    }

    var isOpen: Bool {
        !isClosed
    }

    private var isClosed: Bool {
        stateQueue.sync { closed }
    }

    private func receiveControl() {
        controlConnection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, error in
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
    private let graphicsAuthorizer: OwnedGraphicsChannelAuthorizer
    private let motionSignalProvider: @Sendable () -> MotionSignal?

    init(
        configuration: OwnedMediaEncodingConfiguration = .default,
        graphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer,
        motionSignalProvider: @escaping @Sendable () -> MotionSignal? = { nil }
    ) {
        self.configuration = configuration
        self.graphicsAuthorizer = graphicsAuthorizer
        self.motionSignalProvider = motionSignalProvider
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            configuration: configuration,
            graphicsAuthorizer: graphicsAuthorizer,
            motionSignalProvider: motionSignalProvider
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
    private let graphicsAuthorizer: OwnedGraphicsChannelAuthorizer
    private let motionSignalProvider: @Sendable () -> MotionSignal?
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-quic")
    private let lock = NSLock()
    private var graphicsListener: NWListener?
    // ADR-0022: one QUIC connection per client is an NWConnectionGroup carrying two
    // streams (graphics frames + interactive control). Live groups are tracked for
    // teardown; a group still assembling its two streams sits in pendingGraphicsGroups
    // keyed by group identity; streamGroupId maps a stream back to its group so a
    // stream failure can tear the whole session down.
    private var graphicsGroups: [ObjectIdentifier: NWConnectionGroup] = [:]
    private var pendingGraphicsGroups: [ObjectIdentifier: PendingGraphicsGroup] = [:]
    private var streamGroupId: [ObjectIdentifier: ObjectIdentifier] = [:]
    private var latestPendingGroupId: ObjectIdentifier?
    private var graphicsChannels: [ObjectIdentifier: OwnedGraphicsChannelServer] = [:]
    private var activeGraphicsConnectionId: ObjectIdentifier?
    // ADR-0022: the graphics path is two QUIC connections per session. A graphics
    // connection that authenticated but has not yet been paired with its sibling
    // interactive connection waits here, keyed by session id. Any connection (either
    // role) maps back to the graphics-connection id that keys its installed channel,
    // so dropping either tears the whole session down.
    private var connectionToChannelKey: [ObjectIdentifier: ObjectIdentifier] = [:]
    private var videoSource: VideoFrameSource?
    private var frameMailbox: LatestCapturedFrameMailbox?
    private var encodePumpTask: Task<Void, Never>?
    private var graphicsBackpressure = GraphicsBackpressure(
        maxUnacked: Config.hybridMaxUnackedFrames,
        maxUnackedBytes: Config.hybridMaxUnackedBytes
    )
    // A1: token-bucket pacer keeping the average wire send-rate near the link budget.
    private var graphicsSendPacer = GraphicsSendPacer(
        bytesPerSecond: Double(Config.hybridLinkBytesPerSecond),
        burstBytes: Double(Config.hybridSendPacerBurstBytes)
    )
    private var pendingGraphicsResetRequest: OwnedGraphicsResetRequest?
    private var graphicsRecoveryState: HybridGraphicsRecoveryState = .idle
    private let graphicsAckWaiter = OwnedGraphicsAckWaiter()
    private var diagnostics = OwnedMediaHostDiagnostics()
    private let frameScaler = OwnedMediaFrameScaler()
    private var started = false
    // ADR-0025 motion carrier. The video stream rides QUIC DATAGRAM frames on the
    // graphics group; the QUIC session already encrypts and authenticates the
    // channel, so the per-packet HMAC is an integrity check keyed by a shared
    // constant rather than a session secret. The pump publishes its encoder here so
    // the group's datagram receive handler can honor a client keyframe request.
    private static let videoDatagramKey = MediaDatagramCrypto.key(
        mediaCapability: "owned-hevc-motion",
        clientNonce: Data(),
        serverNonce: Data()
    )
    private var videoEncoder: VideoToolboxOwnedMediaEncoder?
    // ADR-0025 diagnostics for the datagram carrier send path. A nil group means the
    // active-connection/group lookup failed, so every send no-ops silently; a send
    // error is reported by Network.framework's completion (otherwise ignored). Both
    // counters are read/reset by the encode pump's per-frame log, all on `queue`.
    private var videoDatagramGroupMisses = 0
    private var videoDatagramSendErrors = 0
    private var lastVideoDatagramSendError: String?

    init(
        configuration: OwnedMediaEncodingConfiguration = .default,
        graphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer,
        motionSignalProvider: @escaping @Sendable () -> MotionSignal? = { nil }
    ) {
        self.configuration = configuration
        self.graphicsAuthorizer = graphicsAuthorizer
        self.motionSignalProvider = motionSignalProvider
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
        let graphicsGroups = Array(self.graphicsGroups.values)
        self.graphicsGroups.removeAll()
        self.pendingGraphicsGroups.removeAll()
        self.streamGroupId.removeAll()
        self.latestPendingGroupId = nil
        self.connectionToChannelKey.removeAll()
        let graphicsChannels = Array(self.graphicsChannels.values)
        self.graphicsChannels.removeAll()
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
        graphicsChannels.forEach { $0.close() }
        graphicsGroups.forEach { $0.cancel() }
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
        // Each inbound QUIC connection is delivered as an NWConnectionGroup; its
        // streams arrive via the group's own newConnectionHandler.
        listener.newConnectionGroupHandler = { [weak self] group in
            self?.handleGraphicsGroup(group)
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
        // ADR-0022: the client opens two streams (graphics + interactive) per QUIC
        // connection, plus the group's implicit stream 0. Allow several inbound
        // bidirectional streams; the default is too small.
        options.initialMaxStreamsBidirectional = 8
        options.initialMaxStreamsUnidirectional = 8
        sec_protocol_options_set_local_identity(options.securityProtocolOptions, secIdentity)
        return NWParameters(quic: options)
    }

    private func handleGraphicsGroup(_ group: NWConnectionGroup) {
        let groupId = ObjectIdentifier(group)
        lock.withLock {
            graphicsGroups[groupId] = group
            pendingGraphicsGroups[groupId] = PendingGraphicsGroup(group: group)
            latestPendingGroupId = groupId
        }
        group.newConnectionHandler = { [weak self] stream in
            self?.handleGraphicsStream(stream, groupId: groupId)
        }
        // ADR-0025: inbound QUIC datagrams on this group are owned-media control
        // (client -> host), currently the keyframe request. Video frames flow the
        // other way (host -> client) and are not received here.
        if Config.ownedMediaVideoMotionEnabled {
            group.setReceiveHandler(maximumMessageSize: 64 * 1024, rejectOversizedMessages: false) { [weak self] _, content, _ in
                guard let self, let content, !content.isEmpty else { return }
                self.handleVideoControlDatagram(content)
            }
        }
        group.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned graphics quic group state=\(String(describing: state), privacy: .public)")
            switch state {
            case .cancelled, .failed:
                self?.removeGraphicsGroup(groupId, reason: "group-\(String(describing: state))")
            default:
                break
            }
        }
        group.start(queue: queue)
    }

    // ADR-0025 motion carrier helpers.
    private func handleVideoControlDatagram(_ data: Data) {
        guard let message = try? JSONDecoder().decode(OwnedMediaControlMessage.self, from: data) else { return }
        switch message.kind {
        case .keyframeRequest:
            let encoder = lock.withLock { videoEncoder }
            encoder?.requestKeyframe()
            logger.notice("owned media video keyframe-request from client frame=\(message.frameId, privacy: .public)")
        default:
            break
        }
    }

    private func sendVideoDatagram(_ data: Data) {
        guard let group = latestVideoGroup() else {
            lock.withLock { videoDatagramGroupMisses &+= 1 }
            return
        }
        group.send(content: data, completion: { [weak self] error in
            guard let self, let error else { return }
            self.lock.withLock {
                self.videoDatagramSendErrors &+= 1
                self.lastVideoDatagramSendError = String(describing: error)
            }
        })
    }

    private func latestVideoGroup() -> NWConnectionGroup? {
        lock.withLock {
            guard let id = activeGraphicsConnectionId, let groupId = streamGroupId[id] else { return nil }
            return graphicsGroups[groupId]
        }
    }

    // Each inbound stream is routed by its 1-byte role tag. The group owns an
    // implicit stream 0 that never sends a role byte, so a stream that yields no
    // valid role is ignored and must NOT tear the group down.
    private func handleGraphicsStream(_ stream: NWConnection, groupId: ObjectIdentifier) {
        let streamId = ObjectIdentifier(stream)
        lock.withLock { streamGroupId[streamId] = groupId }
        stream.stateUpdateHandler = { [weak self, weak stream] state in
            switch state {
            case .cancelled, .failed:
                if let stream {
                    self?.handleGraphicsStreamDown(ObjectIdentifier(stream), groupId: groupId, reason: String(describing: state))
                }
            default:
                break
            }
        }
        stream.start(queue: queue)
        stream.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak stream] data, _, _, error in
            guard let self, let stream else { return }
            if let error {
                self.handleGraphicsStreamDown(ObjectIdentifier(stream), groupId: groupId, reason: "stream-receive-failed")
                return
            }
            guard let data, let roleByte = data.first,
                  let role = OwnedGraphicsStreamRole(rawValue: roleByte) else {
                // Implicit stream 0 or a stray stream: ignore without teardown.
                self.logger.notice("owned graphics quic stream-ignored (no role tag)")
                return
            }
            switch role {
            case .graphics:
                let helloData = Data(data.dropFirst())
                Task { [weak self, weak stream] in
                    await self?.acceptGraphicsHello(helloData, on: stream, groupId: groupId)
                }
            case .interactive:
                // Trusted sibling on the same authenticated QUIC connection: no hello.
                self.pairInteractiveStream(stream, groupId: groupId)
            }
        }
    }

    // The graphics stream authenticates and sends ready, then the group waits for
    // its interactive sibling before the channel is installed and the pump can send.
    private func acceptGraphicsHello(_ data: Data, on stream: NWConnection?, groupId: ObjectIdentifier) async {
        guard let stream else { return }
        do {
            let hello = try OwnedGraphicsHandshake.validateHelloData(data)
            let result = await graphicsAuthorizer(hello)
            switch result {
            case .accepted(let fingerprint):
                let stale = lock.withLock { latestPendingGroupId != groupId || pendingGraphicsGroups[groupId] == nil }
                if stale {
                    logger.notice("owned graphics stale-hello-ignored session=\(hello.sessionId, privacy: .public)")
                    removeGraphicsGroup(groupId, reason: "stale-hello")
                    return
                }
                let serverNonce = try Self.randomBytes(count: 32)
                let ready = GraphicsChannelReady(sessionId: hello.sessionId, serverNonce: serverNonce)
                try await sendReady(try JSONEncoder().encode(ready), on: stream)
                lock.withLock {
                    pendingGraphicsGroups[groupId]?.graphicsStream = stream
                    pendingGraphicsGroups[groupId]?.graphicsAuthed = true
                }
                logger.notice("owned graphics quic accepted-awaiting-interactive fp=\(fingerprint.rawValue, privacy: .public) session=\(hello.sessionId, privacy: .public)")
                tryInstallGraphicsChannel(groupId: groupId)
            case .rejected(let reason):
                logger.error("owned graphics quic rejected reason=\(reason.rawValue, privacy: .public) fp=\(hello.deviceFingerprint.rawValue, privacy: .public)")
                removeGraphicsGroup(groupId, reason: "rejected-\(reason.rawValue)")
            }
        } catch {
            logger.error("owned graphics quic hello failed: \(String(describing: error), privacy: .public)")
            removeGraphicsGroup(groupId, reason: "hello-failed")
        }
    }

    private func pairInteractiveStream(_ stream: NWConnection, groupId: ObjectIdentifier) {
        lock.withLock { pendingGraphicsGroups[groupId]?.interactiveStream = stream }
        logger.notice("owned graphics quic interactive-stream-arrived")
        tryInstallGraphicsChannel(groupId: groupId)
    }

    // Install once the group has BOTH an authenticated graphics stream and an
    // interactive stream. The interactive stream is trusted as a sibling on the
    // same authenticated QUIC connection (ADR-0022 auth: hello on first stream).
    private func tryInstallGraphicsChannel(groupId: ObjectIdentifier) {
        let pair: (graphics: NWConnection, interactive: NWConnection)? = lock.withLock {
            guard let pending = pendingGraphicsGroups[groupId],
                  pending.graphicsAuthed,
                  let graphics = pending.graphicsStream,
                  let interactive = pending.interactiveStream else { return nil }
            pendingGraphicsGroups.removeValue(forKey: groupId)
            let key = ObjectIdentifier(graphics)
            connectionToChannelKey[ObjectIdentifier(graphics)] = key
            connectionToChannelKey[ObjectIdentifier(interactive)] = key
            return (graphics, interactive)
        }
        guard let pair else { return }
        installGraphicsChannel(OwnedGraphicsChannelServer(
            graphicsConnection: pair.graphics,
            controlConnection: pair.interactive,
            onFrameAck: { [weak self] connectionId, ack in
                self?.noteGraphicsFrameAck(ack, connectionId: connectionId)
            },
            onResetRequest: { [weak self] request in
                self?.handleGraphicsResetRequest(request)
            }
        ))
        logger.notice("owned graphics quic interactive-paired channel-installed")
    }

    // A stream going down tears the whole session down if it is part of the active
    // channel or a pending group's graphics/interactive stream. The implicit stream
    // 0 is in neither, so its drop is ignored.
    private func handleGraphicsStreamDown(_ streamId: ObjectIdentifier, groupId: ObjectIdentifier, reason: String) {
        let shouldTearDown = lock.withLock { () -> Bool in
            streamGroupId.removeValue(forKey: streamId)
            if connectionToChannelKey[streamId] != nil { return true }
            if let pending = pendingGraphicsGroups[groupId] {
                if let g = pending.graphicsStream, ObjectIdentifier(g) == streamId { return true }
                if let i = pending.interactiveStream, ObjectIdentifier(i) == streamId { return true }
            }
            return false
        }
        if shouldTearDown {
            removeGraphicsGroup(groupId, reason: "stream-down-\(reason)")
        }
    }

    // Tear down a whole QUIC connection (group): its channel (if installed), its
    // streams, and its bookkeeping; run the recovery path if it was the active one.
    private func removeGraphicsGroup(_ groupId: ObjectIdentifier, reason: String) {
        let result = lock.withLock { () -> (wasActive: Bool, channel: OwnedGraphicsChannelServer?, group: NWConnectionGroup?) in
            let group = graphicsGroups.removeValue(forKey: groupId)
            pendingGraphicsGroups.removeValue(forKey: groupId)
            if latestPendingGroupId == groupId { latestPendingGroupId = nil }
            let groupStreamIds = streamGroupId.filter { $0.value == groupId }.map(\.key)
            let channelKey = groupStreamIds.compactMap { connectionToChannelKey[$0] }.first
            for sid in groupStreamIds {
                streamGroupId.removeValue(forKey: sid)
                connectionToChannelKey.removeValue(forKey: sid)
            }
            var channel: OwnedGraphicsChannelServer?
            var wasActive = false
            if let channelKey {
                channel = graphicsChannels.removeValue(forKey: channelKey)
                if activeGraphicsConnectionId == channelKey {
                    wasActive = true
                    activeGraphicsConnectionId = nil
                    graphicsBackpressure.reset()
                    if graphicsRecoveryState != .failedCoolingDown {
                        graphicsRecoveryState = .reconnecting
                    }
                }
            }
            return (wasActive, channel, group)
        }
        result.channel?.close()
        result.group?.cancel()
        if result.wasActive {
            graphicsAckWaiter.reset()
            logger.notice("owned graphics active-channel-disconnected reason=\(reason, privacy: .public) recoveryState=\(self.currentGraphicsRecoveryState().rawValue, privacy: .public)")
        } else {
            logger.notice("owned graphics group-removed reason=\(reason, privacy: .public)")
        }
    }

    private func installGraphicsChannel(_ channel: OwnedGraphicsChannelServer) {
        let previousChannels = lock.withLock { () -> [OwnedGraphicsChannelServer] in
            let id = ObjectIdentifier(channel.connection)
            let previous = graphicsChannels.filter { key, _ in key != id }.map(\.value)
            graphicsChannels = [id: channel]
            activeGraphicsConnectionId = id
            graphicsBackpressure.reset()
            graphicsRecoveryState = pendingGraphicsResetRequest == nil ? .idle : .reconnecting
            return previous
        }
        graphicsAckWaiter.reset()
        previousChannels.forEach { $0.close() }
        if !previousChannels.isEmpty {
            logger.notice("owned graphics active-channel-replaced oldChannels=\(previousChannels.count, privacy: .public)")
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
        // Backpressure signal for the MotionGovernor: how many frames were held at
        // the unacked cap since the last produce. A non-zero count means the link
        // could not drain the last frame before the next arrived (a flick the link
        // cannot keep up with), which widens the governor's minimum produce interval.
        var heldSinceLastProduce = 0
        // Uptime of the last produced frame, for the governor's cadence cap.
        var lastProduceUptimeNs: UInt64?
        let motionGovernor = MotionGovernor()
        // ADR-0025 mixed-mode: when the flag is on, scrolling motion is encoded as
        // hardware HEVC instead of tiled. This increment is the host measurement
        // stage: it encodes the real captured frame and logs the frame size and
        // packet count (the sub-2Mbps signal), then drops the bytes; the datagram
        // carrier and client video path are wired next. The encoder is only created
        // when the flag is on, so the default path holds no VTCompressionSession.
        let videoEncoder: VideoToolboxOwnedMediaEncoder? = Config.ownedMediaVideoMotionEnabled
            ? VideoToolboxOwnedMediaEncoder(
                codec: .hevc,
                configuration: OwnedMediaEncodingConfiguration(
                    targetBitrateKbps: Config.ownedMediaBitrateKbps,
                    expectedFrameRate: Config.ownedMediaExpectedFrameRate,
                    keyframeIntervalFrames: Config.ownedMediaVideoKeyframeIntervalFrames
                )
            )
            : nil
        // Publish the encoder so the group's datagram receive handler can honor a
        // client keyframe request; clear it when the pump ends.
        lock.withLock { self.videoEncoder = videoEncoder }
        defer {
            videoEncoder?.invalidate()
            lock.withLock { self.videoEncoder = nil }
        }
        var videoFrameId: UInt64 = 0
        var wasScrollingForVideo = false
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
            // C3: a pending reset is the recovery path and must own the link. It
            // bypasses the backpressure, cadence, and rate gates below so the caps
            // (especially the byte-rate pacer, which can sit in debt after a fast
            // scroll) cannot starve the reset stripe and re-create the freeze the
            // reset exists to break. handleGraphicsResetRequest already cleared the
            // unacked tracker, so the surface is re-synced at full priority.
            let resetPending = peekPendingGraphicsResetRequest() != nil
            if resetPending {
                scrollDeltaEngine.invalidateRetainedSurface()
                logger.notice("owned graphics reset consumed by encode pump")
            }
            if !resetPending, !graphicsBackpressureCanProduce() {
                // At the unacked-frame cap. Hold this frame entirely. The mailbox
                // coalesces dirtyRects while stalled, so the next produced frame
                // carries the freshest damage.
                diagnostics.noteAdmissionHold(reason: "backpressure-cap")
                logger.notice("owned graphics backpressure-hold reason=unacked-cap maxUnacked=\(Config.hybridMaxUnackedFrames, privacy: .public)")
                heldSinceLastProduce += 1
                continue
            }
            let nowBeforeProbe = DispatchTime.now().uptimeNanoseconds
            // Input declares the motion (nil = rest); the store already applies the
            // active-window debounce, so a lapsed scroll reads as rest.
            let motion = motionSignalProvider()
            let policy = motionGovernor.policy(
                state: motion == nil ? .rest : .scrolling,
                heldCount: heldSinceLastProduce
            )
            // Cadence cap: under backpressure the governor widens the minimum produce
            // interval, so we reject/coalesce this frame instead of generating one the
            // link cannot drain. The mailbox keeps the freshest damage for the next
            // produce; readability is preserved by spending cadence, not quality.
            if !resetPending, let last = lastProduceUptimeNs, nowBeforeProbe &- last < policy.minFrameIntervalNs {
                diagnostics.noteAdmissionHold(reason: "cadence-cap")
                continue
            }
            // A1 byte-rate pacer: hold when the link budget is spent. Unlike the
            // unacked-frame cap, this sees real link saturation even when the client
            // drains frames fast, so sustained fast scroll (100KB+ strips) paces to
            // the link instead of over-filling the send buffer until a reset stripe
            // ack times out. The mailbox coalesces the freshest damage for the next
            // admitted produce, so a held frame costs cadence, not content.
            if !resetPending, !lock.withLock({ graphicsSendPacer.canSend(nowNs: nowBeforeProbe) }) {
                diagnostics.noteAdmissionHold(reason: "rate-cap")
                continue
            }
            heldSinceLastProduce = 0
            lastProduceUptimeNs = nowBeforeProbe

            // ADR-0025 motion fork. While scrolling, encode the frame as HEVC and
            // measure it (the carrier send lands next); the tile path is skipped so
            // the surface is not also retiled. On scroll->rest, invalidate the
            // retained surface so the tile path re-syncs the full surface after the
            // video gap (the post-motion refresh), matching the handoff contract.
            if let videoEncoder, motion != nil {
                let forceKeyframe = !wasScrollingForVideo
                wasScrollingForVideo = true
                videoFrameId &+= 1
                if let envelope = await videoEncoder.encode(
                    frame,
                    updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: videoFrameId),
                    forceKeyframe: forceKeyframe
                ),
                let data = try? envelope.encode(),
                let packets = try? MediaDatagramFramePacket.packetize(
                    frameId: videoFrameId,
                    isKeyframe: envelope.header.isKeyframe,
                    sentAtUptimeNs: frame.capturedAtUptimeNs,
                    payload: data,
                    key: Self.videoDatagramKey
                ) {
                    for packet in packets { sendVideoDatagram(packet) }
                    let shouldLog = envelope.header.isKeyframe || videoFrameId.isMultiple(of: 30)
                    if shouldLog {
                        let (misses, errors, lastError) = lock.withLock {
                            (videoDatagramGroupMisses, videoDatagramSendErrors, lastVideoDatagramSendError)
                        }
                        logger.notice("owned media video sent frame=\(videoFrameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) bytes=\(data.count, privacy: .public) packets=\(packets.count, privacy: .public) bitrateKbps=\(Config.ownedMediaBitrateKbps, privacy: .public) groupMisses=\(misses, privacy: .public) sendErrors=\(errors, privacy: .public) lastErr=\(lastError ?? "none", privacy: .public)")
                    }
                }
                continue
            }
            if wasScrollingForVideo {
                wasScrollingForVideo = false
                scrollDeltaEngine.invalidateRetainedSurface()
                logger.notice("owned media video->tiles scroll-stop, retained surface invalidated for post-motion refresh")
            }

            let graphics = scrollDeltaEngine.evaluate(frame, motion: motion, policy: policy)
            switch graphics.kind {
            case .accepted:
                // ADR-0022 progressive repaint: a large frame is split into several
                // bounded envelopes (same generation, rising frameId). They are sent
                // in order, each awaited, so the client paints them cell-by-cell into
                // its retained surface as they arrive instead of waiting for one big
                // frame. The pacer/backpressure for the NEXT produce cycle accounts
                // for the bytes. (Cross-cycle supersede of an in-flight repaint by
                // newer damage is a future bandwidth optimization, not done here.)
                let envelopes = graphics.envelopes
                guard !envelopes.isEmpty else {
                    diagnostics.noteAdmissionHold(reason: "graphics-accepted-no-envelope")
                    continue
                }
                do {
                    for envelope in envelopes {
                        let encodedBytes = try await graphicsChannel.send(envelope)
                        noteGraphicsFrameSent(envelope, encodedBytes: encodedBytes)
                        // Content tile cache decisions for this envelope: cacheStores is
                        // rung 3 (cacheTile, pixels sent and a slot stored); cacheHits is
                        // rung 2 (drawCachedTile, the client already holds the content so
                        // zero pixel bytes go on the wire). Rung 1 omits a cell entirely.
                        var cacheStores = 0
                        var cacheHits = 0
                        for command in envelope.commands {
                            switch command {
                            case .cacheTile: cacheStores += 1
                            case .drawCachedTile: cacheHits += 1
                            default: break
                            }
                        }
                        logger.notice("owned graphics accepted frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) envelopes=\(envelopes.count, privacy: .public) commands=\(envelope.commands.count, privacy: .public) payloadBytes=\(envelope.payload.count, privacy: .public) cacheStores=\(cacheStores, privacy: .public) cacheHits=\(cacheHits, privacy: .public) acceptedBy=\(graphics.diagnostics?.acceptedBy ?? "unknown", privacy: .public) decision=\(graphics.diagnostics?.timeoutReason ?? "none", privacy: .public)")
                    }
                    scrollDeltaEngine.commitPendingSurface()
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
                        // C2: grace scaled to the configured link rate and this stripe's
                        // size, floored at the prior fixed attempts. A slower link (or a
                        // larger stripe) gets proportionally longer to drain its ack
                        // before the channel is declared dead, instead of a fixed count
                        // the device freeze's 6.6s drain exceeded.
                        let graceAttempts = Config.resetStripeAckGraceAttempts(stripeBytes: envelope.payload.count)
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
                            if ackAttempt >= graceAttempts {
                                throw OwnedGraphicsResetSendError.ackTimeout(envelope.header.updateId)
                            }
                            logger.notice("owned graphics reset-stripe-ack-slow frame=\(envelope.header.frameId, privacy: .public) generation=\(envelope.header.surfaceGeneration, privacy: .public) attempt=\(ackAttempt, privacy: .public) maxAttempts=\(graceAttempts, privacy: .public)")
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
            graphicsBackpressure.noteSent(frameId: envelope.header.frameId, bytes: encodedBytes)
            // Debit the pacer by the real wire size (A1). Reset-stripe sends route
            // here too, so their bytes are paced like any other link traffic.
            graphicsSendPacer.consume(bytes: encodedBytes, nowNs: DispatchTime.now().uptimeNanoseconds)
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

