import CryptoKit
import Foundation
import Network

protocol SessionTransport: AnyObject, Sendable {
    var activeSession: ActiveSession { get }
    var mediaKey: SymmetricKey { get }
    func close()
}

enum QuicSessionStreamRole: UInt8, Codable, Equatable, Sendable {
    case control = 1
    case input = 2
}

enum QuicSessionFrameError: Error, Equatable {
    case frameTooLarge
    case malformed
    case unknownRole
}

struct QuicSessionStreamFrame: Equatable {
    static let maxFrameLength = 4 * 1024 * 1024

    let role: QuicSessionStreamRole
    let payload: Data

    static func encode(role: QuicSessionStreamRole, payload: Data) throws -> Data {
        guard payload.count <= maxFrameLength else { throw QuicSessionFrameError.frameTooLarge }
        var data = Data()
        data.append(role.rawValue)
        data.appendUInt32BE(UInt32(payload.count))
        data.append(payload)
        return data
    }

    static func decode(_ data: Data) throws -> QuicSessionStreamFrame {
        guard data.count >= 5,
              let role = QuicSessionStreamRole(rawValue: data[data.startIndex])
        else {
            throw QuicSessionFrameError.malformed
        }
        let length = Int(try data.readUInt32BE(at: 1))
        guard length <= maxFrameLength,
              data.count == 5 + length
        else {
            throw QuicSessionFrameError.malformed
        }
        return QuicSessionStreamFrame(
            role: role,
            payload: data.subdata(in: (data.startIndex + 5)..<data.endIndex)
        )
    }
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

    static func receiveFrame(on stream: QUIC.Stream<QUICStream>) async throws -> QuicSessionStreamFrame {
        let header = try await stream.receive(exactly: 5).content
        guard header.count == 5,
              let role = QuicSessionStreamRole(rawValue: header[header.startIndex])
        else {
            throw QuicSessionFrameError.malformed
        }
        let length = Int(try header.readUInt32BE(at: 1))
        guard length <= QuicSessionStreamFrame.maxFrameLength else {
            throw QuicSessionFrameError.frameTooLarge
        }
        let payload = try await stream.receive(exactly: length).content
        guard payload.count == length else {
            throw QuicSessionFrameError.malformed
        }
        return QuicSessionStreamFrame(role: role, payload: payload)
    }
}

extension Data {
    func readUInt32BE(at offset: Int) throws -> UInt32 {
        guard count >= offset + 4 else { throw QuicSessionFrameError.malformed }
        let base = startIndex + offset
        return (UInt32(self[base]) << 24)
            | (UInt32(self[base + 1]) << 16)
            | (UInt32(self[base + 2]) << 8)
            | UInt32(self[base + 3])
    }
}
