import CryptoKit
import Foundation
import Network
import AgentDeskWire

protocol SessionTransport: AnyObject, Sendable {
    var activeSession: ActiveSession { get }
    var mediaKey: SymmetricKey { get }
    func close()
}

@available(iOS 26.0, *)
enum QuicSessionStreamIO {
    static func send<T: Encodable>(
        _ value: T,
        role: QuicSessionStreamRole,
        on stream: QUIC.Stream<QUICStream>
    ) async throws {
        let payload = try JSONEncoder().encode(value)
        try await stream.send(try QuicSessionStreamFrame.encode(role: role, payload: payload))
    }

    static func sendPayload(
        _ payload: Data,
        role: QuicSessionStreamRole,
        on stream: QUIC.Stream<QUICStream>
    ) async throws {
        try await stream.send(try QuicSessionStreamFrame.encode(role: role, payload: payload))
    }

    static func receiveFrame(
        on stream: QUIC.Stream<QUICStream>,
        expectedRole: QuicSessionStreamRole? = nil
    ) async throws -> QuicSessionStreamFrame {
        let header = try await stream.receive(exactly: 5).content
        // A short read here is the stream ending, not a bad frame. Reporting it as `malformed`
        // made every handover look like a protocol violation on both peers.
        guard header.count == 5 else {
            throw QuicSessionFrameError.streamEnded(expected: 5, received: header.count)
        }
        guard let role = QuicSessionStreamRole(rawValue: header[header.startIndex]) else {
            throw QuicSessionFrameError.malformed
        }
        guard expectedRole == nil || expectedRole == role else {
            throw QuicSessionFrameError.malformed
        }
        let length = Int(try header.readUInt32BE(at: 1))
        let boundedRole = expectedRole ?? role
        guard length <= QuicSessionStreamFrame.maxFrameLength(for: boundedRole) else {
            throw QuicSessionFrameError.frameTooLarge
        }
        let payload = try await stream.receive(exactly: length).content
        guard payload.count == length else {
            throw QuicSessionFrameError.streamEnded(expected: length, received: payload.count)
        }
        return QuicSessionStreamFrame(role: role, payload: payload)
    }
}
