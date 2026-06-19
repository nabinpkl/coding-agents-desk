import Foundation
import Network
import os
import CryptoKit

final class OwnedMediaChannelServer: OwnedMediaChannelServing, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media-datagram")
    private let connection: NWConnection
    private let fingerprint: DeviceFingerprint
    private let key: SymmetricKey
    private let stateQueue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-datagram-state")
    private var closed = false
    private var newestFrameId: UInt64 = 0

    init(connection: NWConnection, fingerprint: DeviceFingerprint, key: SymmetricKey) {
        self.connection = connection
        self.fingerprint = fingerprint
        self.key = key
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media datagram state=\(String(describing: state), privacy: .public) fp=\(fingerprint.rawValue, privacy: .public)")
            switch state {
            case .cancelled, .failed:
                self?.markClosed()
            default:
                break
            }
        }
    }

    func send(_ envelope: OwnedMediaFrameEnvelope) async throws {
        guard !isClosed else {
            throw SessionRejected(reason: .unauthorized)
        }
        let data = try envelope.encode()
        let frameId = noteNewestFrame()
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: frameId,
            sentAtUptimeNs: envelope.header.capturedAtUptimeNs,
            payload: data,
            key: key
        )
        for packet in packets {
            guard shouldContinueSending(frameId: frameId), !isClosed else { return }
            try await sendDatagram(packet)
        }
    }

    func close() {
        guard markClosed() else { return }
        connection.cancel()
    }

    private var isClosed: Bool {
        stateQueue.sync { closed }
    }

    private func noteNewestFrame() -> UInt64 {
        stateQueue.sync {
            newestFrameId &+= 1
            return newestFrameId
        }
    }

    private func shouldContinueSending(frameId: UInt64) -> Bool {
        stateQueue.sync { frameId == newestFrameId }
    }

    @discardableResult
    private func markClosed() -> Bool {
        stateQueue.sync {
            guard !closed else { return false }
            closed = true
            return true
        }
    }

    private func sendDatagram(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(
                content: data,
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
}

enum MediaDatagramPacketError: Error {
    case malformed
    case authenticationFailed
}

struct MediaDatagramFramePacket: Equatable {
    static let maxPayloadBytes = 1_050
    private static let magic = Data([0x41, 0x44, 0x4d, 0x44]) // ADMD
    private static let version: UInt8 = 1
    private static let frameKind: UInt8 = 3
    private static let headerPrefixLength = 30
    private static let macLength = 32

    let frameId: UInt64
    let packetIndex: UInt16
    let packetCount: UInt16
    let sentAtUptimeNs: UInt64
    let payload: Data

    static func packetize(
        frameId: UInt64,
        sentAtUptimeNs: UInt64,
        payload: Data,
        key: SymmetricKey
    ) throws -> [Data] {
        let count = max(1, Int(ceil(Double(payload.count) / Double(maxPayloadBytes))))
        guard count <= Int(UInt16.max) else { throw MediaDatagramPacketError.malformed }
        var packets: [Data] = []
        packets.reserveCapacity(count)
        for index in 0..<count {
            let start = index * maxPayloadBytes
            let end = min(payload.count, start + maxPayloadBytes)
            let chunk = payload.subdata(in: start..<end)
            packets.append(try encode(
                frameId: frameId,
                packetIndex: UInt16(index),
                packetCount: UInt16(count),
                sentAtUptimeNs: sentAtUptimeNs,
                payload: chunk,
                key: key
            ))
        }
        return packets
    }

    static func decode(_ data: Data, key: SymmetricKey) throws -> MediaDatagramFramePacket {
        guard data.count >= headerPrefixLength + macLength,
              data.prefix(4) == magic,
              data[4] == version,
              data[5] == frameKind
        else {
            throw MediaDatagramPacketError.malformed
        }
        let payloadLength = Int(try data.readUInt16BE(at: 28))
        let expectedLength = headerPrefixLength + macLength + payloadLength
        guard data.count == expectedLength else {
            throw MediaDatagramPacketError.malformed
        }
        let payload = data.suffix(payloadLength)
        var authenticated = Data(data.prefix(headerPrefixLength))
        authenticated.append(payload)
        let expectedMac = HMAC<SHA256>.authenticationCode(for: authenticated, using: key)
        let actualMac = data.subdata(in: headerPrefixLength..<(headerPrefixLength + macLength))
        guard Data(expectedMac) == actualMac else {
            throw MediaDatagramPacketError.authenticationFailed
        }
        let packetCount = try data.readUInt16BE(at: 20)
        guard packetCount > 0 else { throw MediaDatagramPacketError.malformed }
        return MediaDatagramFramePacket(
            frameId: try data.readUInt64BE(at: 10),
            packetIndex: try data.readUInt16BE(at: 18),
            packetCount: packetCount,
            sentAtUptimeNs: try data.readUInt64BE(at: 22),
            payload: Data(payload)
        )
    }

    private static func encode(
        frameId: UInt64,
        packetIndex: UInt16,
        packetCount: UInt16,
        sentAtUptimeNs: UInt64,
        payload: Data,
        key: SymmetricKey
    ) throws -> Data {
        guard payload.count <= maxPayloadBytes else {
            throw MediaDatagramPacketError.malformed
        }
        var prefix = Data()
        prefix.append(magic)
        prefix.append(version)
        prefix.append(frameKind)
        prefix.appendUInt32BE(0)
        prefix.appendUInt64BE(frameId)
        prefix.appendUInt16BE(packetIndex)
        prefix.appendUInt16BE(packetCount)
        prefix.appendUInt64BE(sentAtUptimeNs)
        prefix.appendUInt16BE(UInt16(payload.count))
        var authenticated = prefix
        authenticated.append(payload)
        let mac = HMAC<SHA256>.authenticationCode(for: authenticated, using: key)
        var packet = prefix
        packet.append(Data(mac))
        packet.append(payload)
        return packet
    }
}

struct MediaDatagramCrypto {
    static func key(mediaCapability: String, clientNonce: Data, serverNonce: Data) -> SymmetricKey {
        var seed = Data("agentdesk-owned-media-datagram-v1".utf8)
        seed.append(Data(mediaCapability.utf8))
        seed.append(clientNonce)
        seed.append(serverNonce)
        let digest = SHA256.hash(data: seed)
        return SymmetricKey(data: Data(digest))
    }
}

extension Data {
    mutating func appendUInt16BE(_ value: UInt16) {
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    mutating func appendUInt32BE(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    mutating func appendUInt64BE(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            append(UInt8((value >> shift) & 0xff))
        }
    }

    func readUInt16BE(at offset: Int) throws -> UInt16 {
        guard count >= offset + 2 else { throw MediaDatagramPacketError.malformed }
        return (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
    }

    func readUInt64BE(at offset: Int) throws -> UInt64 {
        guard count >= offset + 8 else { throw MediaDatagramPacketError.malformed }
        var value: UInt64 = 0
        for index in offset..<(offset + 8) {
            value = (value << 8) | UInt64(self[index])
        }
        return value
    }
}
