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

private struct FirstFrameEnvelope: Decodable {
    let type: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case typeLong = "type"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let t = try container.decodeIfPresent(String.self, forKey: .type) {
            self.type = t
        } else if let t = try container.decodeIfPresent(String.self, forKey: .typeLong) {
            self.type = t
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "no type field"))
        }
    }
}

final class PairingSignalingServer: @unchecked Sendable {
    typealias ApprovalHandler = (DeviceFingerprint, @escaping (Bool) -> Void) -> Void
    typealias SessionAttemptStartedHandler = (DeviceFingerprint) -> Void
    typealias SessionReadyHandler = (ActiveSession) -> Void
    typealias SessionEndedHandler = (DeviceFingerprint) -> Void

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "signaling")
    private let pairing: Pairing
    private let approvalHandler: ApprovalHandler
    private let sessionAttemptStartedHandler: SessionAttemptStartedHandler
    private let sessionReadyHandler: SessionReadyHandler
    private let sessionEndedHandler: SessionEndedHandler
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: ConnectionContext] = [:]

    init(
        pairing: Pairing,
        approvalHandler: @escaping ApprovalHandler,
        sessionAttemptStartedHandler: @escaping SessionAttemptStartedHandler = { _ in },
        sessionReadyHandler: @escaping SessionReadyHandler = { _ in },
        sessionEndedHandler: @escaping SessionEndedHandler = { _ in }
    ) {
        self.pairing = pairing
        self.approvalHandler = approvalHandler
        self.sessionAttemptStartedHandler = sessionAttemptStartedHandler
        self.sessionReadyHandler = sessionReadyHandler
        self.sessionEndedHandler = sessionEndedHandler
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

        if let context, let phase = context.phase {
            switch phase {
            case .awaitingSessionProof(let authenticator):
                handleSessionProof(data: data, authenticator: authenticator, context: context, on: connection)
                return
            }
        }

        guard let envelope = try? JSONDecoder().decode(FirstFrameEnvelope.self, from: data) else {
            sendSessionRejected(reason: .malformed, on: connection)
            connection.cancel()
            return
        }
        switch envelope.type {
        case "pair":
            handlePair(data: data, on: connection)
        case "session-init":
            handleSessionInit(data: data, context: context, on: connection)
        default:
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
            sessionReadyHandler(active)
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
