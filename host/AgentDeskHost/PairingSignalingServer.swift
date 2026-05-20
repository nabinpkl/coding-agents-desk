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

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "signaling")
    private let pairing: Pairing
    private let approvalHandler: ApprovalHandler
    private var listener: NWListener?
    private var connections: [NWConnection] = []

    init(pairing: Pairing, approvalHandler: @escaping ApprovalHandler) {
        self.pairing = pairing
        self.approvalHandler = approvalHandler
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
            self?.logger.notice("new connection accepted")
            self?.connections.append(connection)
            connection.stateUpdateHandler = { [weak self] state in
                self?.logger.notice("connection state: \(String(describing: state), privacy: .public)")
            }
            self?.receiveNextMessage(on: connection)
            connection.start(queue: .main)
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
        connections.forEach { $0.cancel() }
        connections.removeAll()
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
            do {
                let request = try JSONDecoder().decode(PairingHandshakeRequest.self, from: data)
                self.logger.notice("handshake request decoded type=\(request.type, privacy: .public)")
                try self.handle(request: request, on: connection)
            } catch {
                self.logger.error("ws frame decode/handle failed: \(String(describing: error), privacy: .public)")
                self.send(response: PairingHandshakeResponse(type: "rejected", token: nil, error: "\(error)"), on: connection)
            }
        }
    }

    private func handle(request: PairingHandshakeRequest, on connection: NWConnection) throws {
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
                    self.send(response: PairingHandshakeResponse(type: "rejected", token: nil, error: "rejected"), on: connection)
                    return
                }
                let token = try self.pairing.issueApprovedSessionToken(
                    devicePublicKey: request.devicePublicKey,
                    oneTimeNonce: request.oneTimeNonce
                )
                try self.pairing.markSeen(deviceFingerprint: token.deviceFingerprint)
                self.send(response: PairingHandshakeResponse(type: "approved", token: token, error: nil), on: connection)
            } catch {
                self.send(response: PairingHandshakeResponse(type: "rejected", token: nil, error: "\(error)"), on: connection)
            }
        }
    }

    private func send(response: PairingHandshakeResponse, on connection: NWConnection) {
        do {
            let data = try JSONEncoder().encode(response)
            let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "pair-response", metadata: [metadata])
            connection.send(
                content: data,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { [weak self] error in
                    if let error {
                        self?.logger.error("ws send failed: \(String(describing: error), privacy: .public)")
                    } else {
                        self?.logger.notice("ws response sent bytes=\(data.count, privacy: .public)")
                    }
                }
            )
        } catch {
            logger.error("response encode failed: \(String(describing: error), privacy: .public)")
            connection.cancel()
        }
    }
}

enum PairingSignalError: Error {
    case invalidFrame
    case unsupportedMessage
}
