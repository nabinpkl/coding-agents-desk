import Foundation
import Network
import os

struct PairingHandshakeRequest: Codable {
    let type: String
    let devicePublicKey: Data
    let oneTimeNonce: Data
}

struct PairingHandshakeResponse: Codable {
    let type: String
    let token: SessionToken?
    let error: String?
}

final class PairingSignalingServer: @unchecked Sendable {
    typealias ApprovalHandler = (DeviceFingerprint, @escaping (Bool) -> Void) -> Void
    typealias SessionAttemptStartedHandler = (DeviceFingerprint) -> Void
    typealias SessionReadyHandler = (ActiveSession, SignalingChannel) -> Void
    typealias SessionEndedHandler = (DeviceFingerprint) -> Void
    typealias InputChannelReadyHandler = (DeviceFingerprint, InputChannelServer) -> Void

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "signaling")
    private let pairing: Pairing
    private let approvalHandler: ApprovalHandler
    private let sessionAttemptStartedHandler: SessionAttemptStartedHandler
    private let sessionReadyHandler: SessionReadyHandler
    private let sessionEndedHandler: SessionEndedHandler
    private let inputChannelReadyHandler: InputChannelReadyHandler
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: ConnectionContext] = [:]

    init(
        pairing: Pairing,
        approvalHandler: @escaping ApprovalHandler,
        sessionAttemptStartedHandler: @escaping SessionAttemptStartedHandler = { _ in },
        sessionReadyHandler: @escaping SessionReadyHandler = { _, _ in },
        sessionEndedHandler: @escaping SessionEndedHandler = { _ in },
        inputChannelReadyHandler: @escaping InputChannelReadyHandler = { _, _ in }
    ) {
        self.pairing = pairing
        self.approvalHandler = approvalHandler
        self.sessionAttemptStartedHandler = sessionAttemptStartedHandler
        self.sessionReadyHandler = sessionReadyHandler
        self.sessionEndedHandler = sessionEndedHandler
        self.inputChannelReadyHandler = inputChannelReadyHandler
    }

    func start(port: UInt16 = Config.signalingPort) throws {
        let endpointPort = NWEndpoint.Port(rawValue: port) ?? .any
        let identity = try TLSIdentityLoader(
            certURL: Config.tlsCertURL,
            keyURL: Config.tlsKeyURL,
            identityURL: Config.tlsIdentityURL
        ).loadIdentity()
        guard let secIdentity = sec_identity_create(identity) else {
            throw TLSIdentityError.noIdentityInBundle
        }
        let tlsOptions = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tlsOptions.securityProtocolOptions, secIdentity)
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        let parameters = NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options())
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        let listener = try NWListener(using: parameters, on: endpointPort)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleNewConnection(connection)
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for context in connections.values {
            context.connection.cancel()
        }
        connections.removeAll()
    }

    private func handleNewConnection(_ connection: NWConnection) {
        logger.notice("new connection accepted")
        let context = ConnectionContext(connection: connection)
        connections[ObjectIdentifier(connection)] = context
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("connection state: \(String(describing: state), privacy: .public)")
            switch state {
            case .cancelled, .failed:
                self?.connectionDidClose(connection)
            default:
                break
            }
        }
        receiveNextMessage(on: connection)
        connection.start(queue: .main)
    }

    private func connectionDidClose(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        guard let context = connections.removeValue(forKey: id) else { return }
        context.activeSessionChannel?.close()
        context.activeSessionChannel = nil
        if let fingerprint = context.activeSessionFingerprint ?? context.attemptingFingerprint {
            sessionEndedHandler(fingerprint)
        }
    }

    private func receiveNextMessage(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let error {
                self.logger.error("ws receive error: \(String(describing: error), privacy: .public)")
                connection.cancel()
                return
            }
            guard let data else {
                self.logger.notice("ws receive empty (peer closed)")
                connection.cancel()
                return
            }
            self.logger.notice("ws frame received bytes=\(data.count, privacy: .public)")
            self.dispatch(data: data, on: connection)
        }
    }

    private func dispatch(data: Data, on connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        let context = connections[id]

        if let context, let channel = context.activeSessionChannel {
            handleActiveSessionFrame(data: data, channel: channel, on: connection)
            return
        }

        if let context, let phase = context.phase {
            switch phase {
            case .awaitingSessionProof(let authenticator):
                handleSessionProof(data: data, authenticator: authenticator, context: context, on: connection)
                return
            }
        }

        switch SignalingFrameRouter.classifyFirstFrame(data) {
        case .pair:
            handlePair(data: data, on: connection)
        case .sessionInit:
            handleSessionInit(data: data, context: context, on: connection)
        case .inputHello:
            handleInputHello(data: data, context: context, on: connection)
        case .malformed:
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
        }
    }

    // ADR-0005: input channel first-frame handler. Decodes
    // InputChannelHello, validates the session token against `Pairing`,
    // and hands the connection off to an InputChannelServer that owns
    // its receive loop from here on. The connection is removed from
    // PairingSignalingServer's tracking dictionary because input frames
    // no longer route through `dispatch`; the connection lives under
    // SessionRegistry until the session ends.
    private func handleInputHello(data: Data, context: ConnectionContext?, on connection: NWConnection) {
        let hello: InputChannelHello
        do {
            hello = try JSONDecoder().decode(InputChannelHello.self, from: data)
        } catch {
            logger.error("input-hello decode failed: \(String(describing: error), privacy: .public)")
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
            return
        }
        guard pairing.validate(token: hello.sessionToken) else {
            logger.error("input-hello token rejected fp=\(hello.sessionToken.deviceFingerprint.rawValue, privacy: .public)")
            sendSessionRejected(reason: .unauthorized, on: connection)
            connection.cancel()
            return
        }
        let fingerprint = hello.sessionToken.deviceFingerprint
        logger.notice("input-hello accepted fp=\(fingerprint.rawValue, privacy: .public)")
        // Detach from PairingSignalingServer's connection tracking so
        // its dispatch loop never sees subsequent frames on this
        // connection. InputChannelServer owns the receive loop now.
        if let context {
            context.connection.stateUpdateHandler = nil
            connections.removeValue(forKey: ObjectIdentifier(context.connection))
        }
        let server = InputChannelServer(connection: connection, fingerprint: fingerprint)
        inputChannelReadyHandler(fingerprint, server)
    }

    private func handleActiveSessionFrame(
        data: Data,
        channel: WebSocketSignalingChannel,
        on connection: NWConnection
    ) {
        switch SignalingFrameRouter.classifyActiveSessionFrame(data) {
        case .webrtc(let frame):
            channel.deliver(frame)
            receiveNextMessage(on: connection)
        case .malformed:
            logger.error("active-session frame malformed")
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
        }
    }

    private func handlePair(data: Data, on connection: NWConnection) {
        do {
            let request = try JSONDecoder().decode(PairingHandshakeRequest.self, from: data)
            logger.notice("pair request decoded type=\(request.type, privacy: .public)")
            try handlePair(request: request, on: connection)
        } catch {
            logger.error("pair frame decode/handle failed: \(String(describing: error), privacy: .public)")
            send(pairResponse: PairingHandshakeResponse(type: "rejected", token: nil, error: "\(error)"), on: connection)
        }
    }

    private func handlePair(request: PairingHandshakeRequest, on connection: NWConnection) throws {
        guard request.type == "pair" else {
            throw PairingSignalError.unsupportedMessage
        }
        let fingerprint = try pairing.pendingDeviceFingerprint(
            devicePublicKey: request.devicePublicKey,
            oneTimeNonce: request.oneTimeNonce
        )
        logger.notice("invoking approval handler for fingerprint=\(fingerprint.rawValue, privacy: .public)")
        approvalHandler(fingerprint) { [weak self, weak connection] approved in
            self?.logger.notice("approval result=\(approved, privacy: .public)")
            guard let self, let connection else { return }
            do {
                guard approved else {
                    self.send(pairResponse: PairingHandshakeResponse(type: "rejected", token: nil, error: "rejected"), on: connection)
                    return
                }
                let token = try self.pairing.issueApprovedSessionToken(
                    devicePublicKey: request.devicePublicKey,
                    oneTimeNonce: request.oneTimeNonce
                )
                try self.pairing.markSeen(deviceFingerprint: token.deviceFingerprint)
                self.send(pairResponse: PairingHandshakeResponse(type: "approved", token: token, error: nil), on: connection)
            } catch {
                self.send(pairResponse: PairingHandshakeResponse(type: "rejected", token: nil, error: "\(error)"), on: connection)
            }
        }
    }

    private func handleSessionInit(data: Data, context: ConnectionContext?, on connection: NWConnection) {
        let initMessage: SessionInit
        do {
            initMessage = try JSONDecoder().decode(SessionInit.self, from: data)
        } catch {
            logger.error("session-init decode failed: \(String(describing: error), privacy: .public)")
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
            return
        }
        let authenticator = SessionAuthenticator(pairing: pairing)
        do {
            let challenge = try authenticator.processInit(initMessage)
            send(sessionMessage: challenge, on: connection)
            context?.phase = .awaitingSessionProof(authenticator)
            context?.attemptingFingerprint = initMessage.deviceFingerprint
            sessionAttemptStartedHandler(initMessage.deviceFingerprint)
            receiveNextMessage(on: connection)
        } catch let rejection as SessionRejected {
            sendSessionRejected(reason: rejection.reason, on: connection)
            connection.cancel()
        } catch {
            logger.error("session-init processing failed: \(String(describing: error), privacy: .public)")
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
        }
    }

    private func handleSessionProof(
        data: Data,
        authenticator: SessionAuthenticator,
        context: ConnectionContext,
        on connection: NWConnection
    ) {
        let proof: SessionProof
        do {
            proof = try JSONDecoder().decode(SessionProof.self, from: data)
        } catch {
            logger.error("session-proof decode failed: \(String(describing: error), privacy: .public)")
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
            return
        }
        do {
            let (ready, active) = try authenticator.processProof(proof)
            send(sessionMessage: ready, on: connection)
            context.phase = nil
            context.attemptingFingerprint = nil
            context.activeSessionFingerprint = active.deviceFingerprint
            let channel = makeActiveSessionChannel(on: connection)
            context.activeSessionChannel = channel
            sessionReadyHandler(active, channel)
            receiveNextMessage(on: connection)
        } catch let rejection as SessionRejected {
            sendSessionRejected(reason: rejection.reason, on: connection)
            connection.cancel()
        } catch {
            logger.error("session-proof processing failed: \(String(describing: error), privacy: .public)")
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
        }
    }

    private func send(pairResponse: PairingHandshakeResponse, on connection: NWConnection) {
        do {
            let data = try JSONEncoder().encode(pairResponse)
            sendWebSocket(data: data, identifier: "pair-response", on: connection)
        } catch {
            logger.error("pair response encode failed: \(String(describing: error), privacy: .public)")
            connection.cancel()
        }
    }

    private func send<T: Encodable>(sessionMessage: T, on connection: NWConnection) {
        do {
            let data = try JSONEncoder().encode(sessionMessage)
            sendWebSocket(data: data, identifier: "session-msg", on: connection)
        } catch {
            logger.error("session message encode failed: \(String(describing: error), privacy: .public)")
            connection.cancel()
        }
    }

    private func sendSessionRejected(reason: SessionRejectionReason, on connection: NWConnection) {
        send(sessionMessage: SessionRejected(reason: reason), on: connection)
    }

    private func makeActiveSessionChannel(on connection: NWConnection) -> WebSocketSignalingChannel {
        WebSocketSignalingChannel(
            sender: { [weak self, weak connection] frame in
                guard let self, let connection else { return }
                try await self.sendActiveSessionFrame(frame, on: connection)
            },
            closer: { [weak connection] in
                connection?.cancel()
            }
        )
    }

    private func sendActiveSessionFrame(_ frame: WebRTCSignalingFrame, on connection: NWConnection) async throws {
        let data = try JSONEncoder().encode(frame)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "webrtc-frame", metadata: [metadata])
            connection.send(
                content: data,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            )
        }
    }

    private func sendWebSocket(data: Data, identifier: String, on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: identifier, metadata: [metadata])
        connection.send(
            content: data,
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { [weak self] error in
                if let error {
                    self?.logger.error("ws send failed: \(String(describing: error), privacy: .public)")
                } else {
                    self?.logger.notice("ws frame sent bytes=\(data.count, privacy: .public)")
                }
            }
        )
    }
}

private final class ConnectionContext {
    let connection: NWConnection
    var phase: SessionPhase?
    var attemptingFingerprint: DeviceFingerprint?
    var activeSessionFingerprint: DeviceFingerprint?
    var activeSessionChannel: WebSocketSignalingChannel?

    init(connection: NWConnection) {
        self.connection = connection
    }
}

private enum SessionPhase {
    case awaitingSessionProof(SessionAuthenticator)
}

enum PairingSignalError: Error {
    case invalidFrame
    case unsupportedMessage
}
