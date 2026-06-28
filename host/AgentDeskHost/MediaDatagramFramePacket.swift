import CryptoKit
import Foundation

// QUIC datagram carrier for the mixed-mode renderer (ADR-0025). A motion HEVC
// frame envelope is fragmented into MTU-sized "ADMD" datagram packets, each HMAC
// authenticated so a forged or corrupted packet cannot inject pixels. Datagrams
// tolerate loss; the client reassembles by frameId and requests resends or a
// keyframe for gaps it cannot fill (see OwnedMediaFrameRepairBuffer on the client
// and OwnedMediaResendRing on the host). Revived from the pre-ADR-0022 path.

enum MediaDatagramPacketError: Error {
    case malformed
    case authenticationFailed
}

struct MediaDatagramFramePacket: Equatable {
    static let maxPayloadBytes = 1_050
    private static let magic = Data([0x41, 0x44, 0x4d, 0x44]) // ADMD
    private static let version: UInt8 = 2
    private static let frameKind: UInt8 = 3
    private static let keyframeFlag: UInt8 = 1 << 0
    private static let headerPrefixLength = 33
    private static let macLength = 32

    let frameId: UInt64
    let packetIndex: UInt16
    let packetCount: UInt16
    let isKeyframe: Bool
    let sentAtUptimeNs: UInt64
    let payload: Data

    static func packetize(
        frameId: UInt64,
        isKeyframe: Bool,
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
                isKeyframe: isKeyframe,
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
              data[data.startIndex + 4] == version,
              data[data.startIndex + 5] == frameKind
        else {
            throw MediaDatagramPacketError.malformed
        }
        let normalized = Data(data)
        let payloadLength = Int(try normalized.readUInt16BE(at: 31))
        let expectedLength = headerPrefixLength + macLength + payloadLength
        guard normalized.count == expectedLength else {
            throw MediaDatagramPacketError.malformed
        }
        let payload = normalized.suffix(payloadLength)
        var authenticated = Data(normalized.prefix(headerPrefixLength))
        authenticated.append(payload)
        let expectedMac = HMAC<SHA256>.authenticationCode(for: authenticated, using: key)
        let actualMac = normalized.subdata(in: headerPrefixLength..<(headerPrefixLength + macLength))
        guard Data(expectedMac) == actualMac else {
            throw MediaDatagramPacketError.authenticationFailed
        }
        let packetCount = try normalized.readUInt16BE(at: 21)
        guard packetCount > 0 else { throw MediaDatagramPacketError.malformed }
        return MediaDatagramFramePacket(
            frameId: try normalized.readUInt64BE(at: 11),
            packetIndex: try normalized.readUInt16BE(at: 19),
            packetCount: packetCount,
            isKeyframe: (normalized[normalized.startIndex + 6] & keyframeFlag) != 0,
            sentAtUptimeNs: try normalized.readUInt64BE(at: 23),
            payload: Data(payload)
        )
    }

    private static func encode(
        frameId: UInt64,
        packetIndex: UInt16,
        packetCount: UInt16,
        isKeyframe: Bool,
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
        prefix.append(isKeyframe ? keyframeFlag : 0)
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
        var seed = Data("agentdesk-owned-media-datagram-v2".utf8)
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
        let base = startIndex + offset
        return (UInt16(self[base]) << 8) | UInt16(self[base + 1])
    }

    func readUInt64BE(at offset: Int) throws -> UInt64 {
        guard count >= offset + 8 else { throw MediaDatagramPacketError.malformed }
        let base = startIndex + offset
        var value: UInt64 = 0
        for index in base..<(base + 8) {
            value = (value << 8) | UInt64(self[index])
        }
        return value
    }
}
