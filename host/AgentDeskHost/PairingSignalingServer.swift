import CryptoKit
import Foundation
import Network
import os
import AgentDeskWire

struct PairingHandshakeRequest: Codable {
    let type: String
    let devicePublicKey: Data
    let oneTimeNonce: Data
    let deviceName: String?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case devicePublicKey
        case oneTimeNonce
        case deviceName
    }
}

struct PairingHandshakeResponse: Codable {
    let type: String
    let token: SessionToken?
    let error: String?
}

@available(macOS 26.0, *)
final class PairingSignalingServer: @unchecked Sendable {
    typealias ApprovalHandler = (DeviceFingerprint, @escaping (Bool) -> Void) -> Void
    typealias SessionAttemptStartedHandler = (DeviceFingerprint) -> Void
    typealias SessionReadyHandler = (
        ActiveSession,
        SessionReady,
        QUIC.Datagrams<QUICDatagram>,
        SymmetricKey
    ) -> Void
    typealias SessionResumeChallengeHandler = (SessionResumeInit) async throws -> SessionResumeChallenge
    typealias SessionResumeChallengeCancelledHandler = (SessionResumeInit) async -> Void
    typealias SessionResumeHandler = (SessionResumeInit, SessionResumeProof) async throws -> (ActiveSession, SessionReady)
    typealias SessionSuspendedHandler = (DeviceFingerprint, String?) -> Void
    typealias SessionEndedHandler = (DeviceFingerprint, String?) -> Void
    typealias InputLaneReadyHandler = (DeviceFingerprint, InputChannelServer) -> Void
    typealias GraphicsLaneReadyHandler = (DeviceFingerprint, GraphicsLaneServer) -> Void
    typealias DomLaneReadyHandler = (DeviceFingerprint, DomEventLaneServer) -> Void
    typealias TerminalLaneReadyHandler = (DeviceFingerprint, TerminalClientBridge) -> Void
    typealias FilesLaneReadyHandler = (DeviceFingerprint, WorkspaceFilesLaneServer) -> Void

    private let logger = Logger(subsystem: Config.logSubsystem, category: "session-quic")
    private let pairing: Pairing
    private let approvalHandler: ApprovalHandler
    private let sessionAttemptStartedHandler: SessionAttemptStartedHandler
    private let sessionReadyHandler: SessionReadyHandler
    private let sessionResumeChallengeHandler: SessionResumeChallengeHandler
    private let sessionResumeChallengeCancelledHandler: SessionResumeChallengeCancelledHandler
    private let sessionResumeHandler: SessionResumeHandler
    private let sessionSuspendedHandler: SessionSuspendedHandler
    private let sessionEndedHandler: SessionEndedHandler
    private let inputLaneReadyHandler: InputLaneReadyHandler
    private let graphicsLaneReadyHandler: GraphicsLaneReadyHandler
    private let domLaneReadyHandler: DomLaneReadyHandler
    private let terminalLaneReadyHandler: TerminalLaneReadyHandler
    private let filesLaneReadyHandler: FilesLaneReadyHandler
    private var listener: NetworkListener<QUIC>?
    private var listenerTask: Task<Void, Never>?
    private let contexts = OSAllocatedUnfairLock<[ObjectIdentifier: ConnectionContext]>(initialState: [:])

    init(
        pairing: Pairing,
        approvalHandler: @escaping ApprovalHandler,
        sessionAttemptStartedHandler: @escaping SessionAttemptStartedHandler = { _ in },
        sessionReadyHandler: @escaping SessionReadyHandler = { _, _, _, _ in },
        sessionResumeChallengeHandler: @escaping SessionResumeChallengeHandler = { _ in throw SessionRejected(reason: .unauthorized) },
        sessionResumeChallengeCancelledHandler: @escaping SessionResumeChallengeCancelledHandler = { _ in },
        sessionResumeHandler: @escaping SessionResumeHandler = { _, _ in throw SessionRejected(reason: .unauthorized) },
        sessionSuspendedHandler: @escaping SessionSuspendedHandler = { _, _ in },
        sessionEndedHandler: @escaping SessionEndedHandler = { _, _ in },
        inputLaneReadyHandler: @escaping InputLaneReadyHandler = { _, _ in },
        graphicsLaneReadyHandler: @escaping GraphicsLaneReadyHandler = { _, _ in },
        domLaneReadyHandler: @escaping DomLaneReadyHandler = { _, _ in },
        terminalLaneReadyHandler: @escaping TerminalLaneReadyHandler = { _, _ in },
        filesLaneReadyHandler: @escaping FilesLaneReadyHandler = { _, _ in }
    ) {
        self.pairing = pairing
        self.approvalHandler = approvalHandler
        self.sessionAttemptStartedHandler = sessionAttemptStartedHandler
        self.sessionReadyHandler = sessionReadyHandler
        self.sessionResumeChallengeHandler = sessionResumeChallengeHandler
        self.sessionResumeChallengeCancelledHandler = sessionResumeChallengeCancelledHandler
        self.sessionResumeHandler = sessionResumeHandler
        self.sessionSuspendedHandler = sessionSuspendedHandler
        self.sessionEndedHandler = sessionEndedHandler
        self.inputLaneReadyHandler = inputLaneReadyHandler
        self.graphicsLaneReadyHandler = graphicsLaneReadyHandler
        self.domLaneReadyHandler = domLaneReadyHandler
        self.terminalLaneReadyHandler = terminalLaneReadyHandler
        self.filesLaneReadyHandler = filesLaneReadyHandler
    }

    func start(port: UInt16 = Config.signalingPort) throws {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw SessionRejected(reason: .malformed)
        }
        let identity = try TLSIdentityLoader(
            certURL: Config.tlsCertURL,
            keyURL: Config.tlsKeyURL,
            identityURL: Config.tlsIdentityURL
        ).loadIdentity()
        guard let secIdentity = sec_identity_create(identity) else {
            throw TLSIdentityError.noIdentityInBundle
        }
        let listener = try NetworkListener<QUIC>(
            for: nil,
            using: NWParametersBuilder(auto: {
                QUIC(alpn: [Config.sessionQuicALPN])
                    .maxDatagramFrameSize(Config.ownedMediaMaxDatagramFrameSize)
                    .initialMaxBidirectionalStreams(8)
                    .idleTimeout(30_000)
                    .tls.localIdentity(secIdentity)
            }).localPort(nwPort)
        )
        listener.onStateUpdate { [logger] _, state in
            logger.notice("session listener state=\(String(describing: state), privacy: .public)")
        }
        listenerTask = Task { [weak self, listener] in
            do {
                try await listener.run { [weak self] connection in
                    await self?.handle(connection)
                }
            } catch {
                self?.logger.error("session listener run failed: \(String(describing: error), privacy: .public)")
            }
        }
        self.listener = listener
    }

    func stop() {
        listenerTask?.cancel()
        listenerTask = nil
        listener = nil
        let values = contexts.withLock { contexts -> [ConnectionContext] in
            let values = Array(contexts.values)
            contexts.removeAll()
            return values
        }
        for context in values {
            context.connection.applicationError = .init(code: 0, reason: "host-stop")
        }
    }

    private func handle(_ connection: NetworkConnection<QUIC>) async {
        let context = ConnectionContext(connection: connection)
        contexts.withLock { $0[ObjectIdentifier(connection)] = context }
        connection.onStateUpdate { [weak self, weak context] _, state in
            self?.logger.notice("session connection state=\(String(describing: state), privacy: .public)")
            switch state {
            case .waiting:
                if let context {
                    self?.notifySuspended(context)
                }
            case .failed, .cancelled:
                if let context {
                    self?.notifyEnded(context)
                }
            default:
                break
            }
        }
        do {
            try await connection.inboundStreams { [weak self, weak context] stream in
                guard let self, let context else { return }
                try await self.handle(stream, context: context)
            }
        } catch {
            logger.notice("inbound stream loop ended: \(String(describing: error), privacy: .public)")
            notifyEnded(context)
        }
    }

    private func handle(_ stream: QUIC.Stream<QUICStream>, context: ConnectionContext) async throws {
        let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
        switch frame.role {
        case .control:
            try await handleControlPayload(frame.payload, stream: stream, context: context)
        case .input:
            guard let active = context.activeSession else {
                try await QuicSessionStreamIO.send(
                    SessionRejected(reason: .unauthorized),
                    role: .input,
                    on: stream
                )
                return
            }
            let server = InputChannelServer(stream: stream, fingerprint: active.deviceFingerprint)
            inputLaneReadyHandler(active.deviceFingerprint, server)
        case .graphics:
            guard let active = context.activeSession else {
                try await QuicSessionStreamIO.send(
                    SessionRejected(reason: .unauthorized),
                    role: .graphics,
                    on: stream
                )
                return
            }
            let lane = GraphicsLaneServer(stream: stream, fingerprint: active.deviceFingerprint)
            graphicsLaneReadyHandler(active.deviceFingerprint, lane)
        case .dom:
            // ADR-0038 DOM-mirror lane. Gated by the master flag: if the subsystem is off, reject
            // cleanly (a client should not open .dom then, but reject rather than hang if it does).
            guard Config.domMirrorEnabled else {
                try await QuicSessionStreamIO.send(
                    SessionRejected(reason: .malformed),
                    role: .dom,
                    on: stream
                )
                return
            }
            guard let active = context.activeSession else {
                try await QuicSessionStreamIO.send(
                    SessionRejected(reason: .unauthorized),
                    role: .dom,
                    on: stream
                )
                return
            }
            let lane = DomEventLaneServer(stream: stream, fingerprint: active.deviceFingerprint)
            domLaneReadyHandler(active.deviceFingerprint, lane)
        case .terminal:
            guard let active = context.activeSession else {
                try await QuicSessionStreamIO.send(
                    SessionRejected(reason: .unauthorized),
                    role: .terminal,
                    on: stream
                )
                return
            }
            let bridge = TerminalClientBridge(stream: stream, fingerprint: active.deviceFingerprint)
            terminalLaneReadyHandler(active.deviceFingerprint, bridge)
        case .files:
            // R26 authenticated Files lane. Requires an active session like the other data lanes;
            // the host's ready handler attaches the request dispatcher (workspace store + file
            // service) and starts the lane.
            guard let active = context.activeSession else {
                try await QuicSessionStreamIO.send(
                    SessionRejected(reason: .unauthorized),
                    role: .files,
                    on: stream
                )
                return
            }
            let lane = WorkspaceFilesLaneServer(stream: stream, fingerprint: active.deviceFingerprint)
            filesLaneReadyHandler(active.deviceFingerprint, lane)
        }
    }

    private func handleControlPayload(
        _ data: Data,
        stream: QUIC.Stream<QUICStream>,
        context: ConnectionContext
    ) async throws {
        guard let envelope = try? JSONDecoder().decode(ControlEnvelope.self, from: data) else {
            try await reject(.malformed, on: stream)
            return
        }
        switch envelope.type {
        case "pair":
            try await handlePair(data: data, on: stream)
        case "session-init":
            try await handleSessionInit(data: data, on: stream, context: context)
        case "session-resume":
            try await handleSessionResume(data: data, on: stream, context: context)
        default:
            try await reject(.malformed, on: stream)
        }
    }

    private func handlePair(data: Data, on stream: QUIC.Stream<QUICStream>) async throws {
        do {
            let request = try JSONDecoder().decode(PairingHandshakeRequest.self, from: data)
            try await handlePair(request: request, on: stream)
        } catch {
            try await QuicSessionStreamIO.send(
                PairingHandshakeResponse(type: "rejected", token: nil, error: "\(error)"),
                role: .control,
                on: stream
            )
        }
    }

    private func handlePair(request: PairingHandshakeRequest, on stream: QUIC.Stream<QUICStream>) async throws {
        guard request.type == "pair" else {
            try await QuicSessionStreamIO.send(
                PairingHandshakeResponse(type: "rejected", token: nil, error: "unsupported"),
                role: .control,
                on: stream
            )
            return
        }
        let fingerprint = try pairing.pendingDeviceFingerprint(
            devicePublicKey: request.devicePublicKey,
            oneTimeNonce: request.oneTimeNonce
        )
        if let preApproval = pairing.consumePreApproval(nonce: request.oneTimeNonce) {
            try await approvePairing(request: request, name: clientName(request) ?? preApproval.name, on: stream)
            return
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            approvalHandler(fingerprint) { [weak self] approved in
                Task {
                    do {
                        guard approved else {
                            try await QuicSessionStreamIO.send(
                                PairingHandshakeResponse(type: "rejected", token: nil, error: "rejected"),
                                role: .control,
                                on: stream
                            )
                            continuation.resume()
                            return
                        }
                        try await self?.approvePairing(request: request, name: self?.clientName(request), on: stream)
                        continuation.resume()
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    private func approvePairing(
        request: PairingHandshakeRequest,
        name: String?,
        on stream: QUIC.Stream<QUICStream>
    ) async throws {
        let token = try pairing.issueApprovedSessionToken(
            devicePublicKey: request.devicePublicKey,
            oneTimeNonce: request.oneTimeNonce
        )
        if let name {
            try? pairing.setName(name, for: token.deviceFingerprint)
        }
        try pairing.markSeen(deviceFingerprint: token.deviceFingerprint)
        try await QuicSessionStreamIO.send(
            PairingHandshakeResponse(type: "approved", token: token, error: nil),
            role: .control,
            on: stream
        )
    }

    private func clientName(_ request: PairingHandshakeRequest) -> String? {
        guard let name = request.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else {
            return nil
        }
        return name
    }

    private func handleSessionInit(
        data: Data,
        on stream: QUIC.Stream<QUICStream>,
        context: ConnectionContext
    ) async throws {
        let initMessage: SessionInit
        do {
            initMessage = try JSONDecoder().decode(SessionInit.self, from: data)
        } catch {
            try await reject(.malformed, on: stream)
            return
        }
        let authenticator = SessionAuthenticator(pairing: pairing)
        do {
            let challenge = try authenticator.processInit(initMessage)
            context.attemptingFingerprint = initMessage.deviceFingerprint
            sessionAttemptStartedHandler(initMessage.deviceFingerprint)
            try await QuicSessionStreamIO.send(challenge, role: .control, on: stream)
            let proofFrame = try await QuicSessionStreamIO.receiveFrame(on: stream)
            guard proofFrame.role == .control else {
                try await reject(.malformed, on: stream)
                return
            }
            let proof = try JSONDecoder().decode(SessionProof.self, from: proofFrame.payload)
            let (ready, active, pending) = try authenticator.processProof(proof)
            let datagrams = try await context.connection.datagrams
            let mediaKey = MediaDatagramCrypto.sessionKey(
                sessionId: ready.sessionId,
                clientNonce: pending.clientNonce,
                hostNonce: pending.hostNonce,
                mediaKeySalt: ready.mediaKeySalt
            )
            context.activeSession = active
            try await QuicSessionStreamIO.send(ready, role: .control, on: stream)
            sessionReadyHandler(active, ready, datagrams, mediaKey)
        } catch let rejection as SessionRejected {
            try await reject(rejection.reason, on: stream)
        } catch {
            logger.error("session-init failed: \(String(describing: error), privacy: .public)")
            try await reject(.malformed, on: stream)
        }
    }

    private func reject(_ reason: SessionRejectionReason, on stream: QUIC.Stream<QUICStream>) async throws {
        try await QuicSessionStreamIO.send(SessionRejected(reason: reason), role: .control, on: stream)
    }

    private func handleSessionResume(
        data: Data,
        on stream: QUIC.Stream<QUICStream>,
        context: ConnectionContext
    ) async throws {
        let request: SessionResumeInit
        do {
            request = try JSONDecoder().decode(SessionResumeInit.self, from: data)
        } catch {
            try await reject(.malformed, on: stream)
            return
        }
        guard !request.clientNonce.isEmpty else {
            try await reject(.malformed, on: stream)
            return
        }
        do {
            context.attemptingFingerprint = request.deviceFingerprint
            sessionAttemptStartedHandler(request.deviceFingerprint)
            let challenge = try await sessionResumeChallengeHandler(request)
            try await QuicSessionStreamIO.send(challenge, role: .control, on: stream)
            let proof: SessionResumeProof
            do {
                let proofFrame = try await QuicSessionStreamIO.receiveFrame(on: stream)
                guard proofFrame.role == .control else {
                    await sessionResumeChallengeCancelledHandler(request)
                    try await reject(.malformed, on: stream)
                    return
                }
                proof = try JSONDecoder().decode(SessionResumeProof.self, from: proofFrame.payload)
            } catch {
                await sessionResumeChallengeCancelledHandler(request)
                throw error
            }
            let (active, ready) = try await sessionResumeHandler(request, proof)
            let datagrams = try await context.connection.datagrams
            let mediaKey = MediaDatagramCrypto.sessionKey(
                sessionId: ready.sessionId,
                clientNonce: request.clientNonce,
                hostNonce: challenge.hostNonce,
                mediaKeySalt: ready.mediaKeySalt
            )
            context.activeSession = active
            try await QuicSessionStreamIO.send(ready, role: .control, on: stream)
            sessionReadyHandler(active, ready, datagrams, mediaKey)
        } catch let rejection as SessionRejected {
            try await reject(rejection.reason, on: stream)
        } catch {
            logger.error("session-resume failed: \(String(describing: error), privacy: .public)")
            try await reject(.malformed, on: stream)
        }
    }

    private func notifySuspended(_ context: ConnectionContext) {
        // AppDelegate maps this to SessionRegistry.suspended and keeps the grace
        // window alive; input/media lanes are suspended, not revoked.
        guard let active = context.activeSession else { return }
        sessionSuspendedHandler(active.deviceFingerprint, active.sessionId)
    }

    private func notifyEnded(_ context: ConnectionContext) {
        _ = contexts.withLock { $0.removeValue(forKey: ObjectIdentifier(context.connection)) }
        if let active = context.activeSession {
            sessionEndedHandler(active.deviceFingerprint, active.sessionId)
        } else if let fingerprint = context.attemptingFingerprint {
            sessionEndedHandler(fingerprint, nil)
        }
    }

    private struct ControlEnvelope: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}

@available(macOS 26.0, *)
private final class ConnectionContext: @unchecked Sendable {
    let connection: NetworkConnection<QUIC>
    var attemptingFingerprint: DeviceFingerprint?
    var activeSession: ActiveSession?

    init(connection: NetworkConnection<QUIC>) {
        self.connection = connection
    }
}
