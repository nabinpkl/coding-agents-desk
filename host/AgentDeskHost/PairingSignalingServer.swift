import CryptoKit
import Foundation
import Network

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
        let listener = try NWListener(using: .tcp, on: endpointPort)
        listener.newConnectionHandler = { [weak self] connection in
            self?.connections.append(connection)
            self?.receiveHTTPUpgrade(on: connection)
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

    private func receiveHTTPUpgrade(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, error in
            guard let self else { return }
            guard error == nil, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            guard let key = self.websocketKey(from: request) else {
                self.sendHTTPResponse("HTTP/1.1 400 Bad Request\r\n\r\n", on: connection)
                return
            }
            self.sendHTTPResponse(self.upgradeResponse(for: key), on: connection)
            self.receiveWebSocketFrame(on: connection)
        }
    }

    private func receiveWebSocketFrame(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 2, maximumLength: 8192) { [weak self] data, _, _, error in
            guard let self else { return }
            guard error == nil, let data else {
                connection.cancel()
                return
            }
            do {
                let payload = try self.decodeClientFrame(data)
                let request = try JSONDecoder().decode(PairingHandshakeRequest.self, from: payload)
                try self.handle(request: request, on: connection)
            } catch {
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
        approvalHandler(fingerprint) { [weak self, weak connection] approved in
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
            connection.send(content: encodeServerTextFrame(data), completion: .contentProcessed { _ in })
        } catch {
            connection.cancel()
        }
    }

    private func sendHTTPResponse(_ response: String, on connection: NWConnection) {
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in })
    }

    private func websocketKey(from request: String) -> String? {
        request
            .components(separatedBy: "\r\n")
            .first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
            .components(separatedBy: ":")
            .dropFirst()
            .joined(separator: ":")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func upgradeResponse(for key: String) -> String {
        let acceptSource = "\(key)258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let accept = Data(Insecure.SHA1.hash(data: Data(acceptSource.utf8))).base64EncodedString()
        return """
        HTTP/1.1 101 Switching Protocols\r
        Upgrade: websocket\r
        Connection: Upgrade\r
        Sec-WebSocket-Accept: \(accept)\r
        \r
        """
    }

    private func decodeClientFrame(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 6 else {
            throw PairingSignalError.invalidFrame
        }
        let opcode = bytes[0] & 0x0f
        guard opcode == 0x1 else {
            throw PairingSignalError.unsupportedMessage
        }
        let masked = (bytes[1] & 0x80) == 0x80
        guard masked else {
            throw PairingSignalError.invalidFrame
        }

        var offset = 2
        var length = Int(bytes[1] & 0x7f)
        if length == 126 {
            guard bytes.count >= 8 else { throw PairingSignalError.invalidFrame }
            length = Int(bytes[2]) << 8 | Int(bytes[3])
            offset = 4
        } else if length == 127 {
            throw PairingSignalError.unsupportedMessage
        }

        guard bytes.count >= offset + 4 + length else {
            throw PairingSignalError.invalidFrame
        }
        let mask = Array(bytes[offset..<offset + 4])
        offset += 4
        var payload = [UInt8]()
        payload.reserveCapacity(length)
        for index in 0..<length {
            payload.append(bytes[offset + index] ^ mask[index % 4])
        }
        return Data(payload)
    }

    private func encodeServerTextFrame(_ payload: Data) -> Data {
        var frame = Data([0x81])
        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else {
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xff))
            frame.append(UInt8(payload.count & 0xff))
        }
        frame.append(payload)
        return frame
    }
}

enum PairingSignalError: Error {
    case invalidFrame
    case unsupportedMessage
}
