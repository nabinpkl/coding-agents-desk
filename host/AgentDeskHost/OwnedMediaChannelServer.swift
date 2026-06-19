import Foundation
import Network
import os
import CryptoKit

final class OwnedMediaChannelServer: OwnedMediaChannelServing, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media-quic")
    private let connection: NWConnection
    private let fingerprint: DeviceFingerprint
    private let key: SymmetricKey
    private let onControlMessage: @Sendable (OwnedMediaControlMessage) -> Void
    private let burstPacketCount: Int
    private let burstPauseUs: Int
    private let backpressureBurstPacketCount: Int
    private let backpressureBurstPauseUs: Int
    private let backpressureConfig: OwnedMediaBackpressureConfig
    private let maxResendPackets: Int
    private let stateQueue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-quic-state")
    private let sendGate = DatagramSendGate()
    private var freshness = OwnedMediaSendFreshness()
    private var resendRing: OwnedMediaResendRing
    private var closed = false
    private var sentFrameCount: UInt64 = 0

    init(
        connection: NWConnection,
        fingerprint: DeviceFingerprint,
        key: SymmetricKey,
        onControlMessage: @escaping @Sendable (OwnedMediaControlMessage) -> Void = { _ in },
        burstPacketCount: Int = Config.ownedMediaDatagramBurstPacketCount,
        burstPauseUs: Int = Config.ownedMediaDatagramBurstPauseUs,
        backpressureBurstPacketCount: Int = Config.ownedMediaBackpressureBurstPacketCount,
        backpressureBurstPauseUs: Int = Config.ownedMediaBackpressureBurstPauseUs,
        backpressureConfig: OwnedMediaBackpressureConfig = OwnedMediaBackpressureConfig(
            renderGapMs: Config.ownedMediaBackpressureRenderGapMs,
            maxInflightFrames: Config.ownedMediaBackpressureMaxInflightFrames,
            maxInflightBytes: Config.ownedMediaBackpressureMaxInflightBytes
        ),
        resendRingFrames: Int = Config.ownedMediaResendRingFrames,
        maxResendPackets: Int = Config.ownedMediaMaxResendPackets
    ) {
        self.connection = connection
        self.fingerprint = fingerprint
        self.key = key
        self.onControlMessage = onControlMessage
        self.burstPacketCount = burstPacketCount
        self.burstPauseUs = burstPauseUs
        self.backpressureBurstPacketCount = backpressureBurstPacketCount
        self.backpressureBurstPauseUs = backpressureBurstPauseUs
        self.backpressureConfig = backpressureConfig
        self.maxResendPackets = maxResendPackets
        self.resendRing = OwnedMediaResendRing(capacityFrames: resendRingFrames)
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media quic state=\(String(describing: state), privacy: .public) fp=\(fingerprint.rawValue, privacy: .public)")
            switch state {
            case .cancelled, .failed:
                self?.markClosed()
            default:
                break
            }
        }
        receiveControlMessage()
    }

    func send(_ envelope: OwnedMediaFrameEnvelope) async throws {
        guard !isClosed else {
            throw SessionRejected(reason: .unauthorized)
        }
        let frameId = envelope.header.frameId
        let isKeyframe = envelope.header.isKeyframe
        noteEnqueued(frameId: frameId, isKeyframe: isKeyframe)
        await sendGate.wait()
        do {
            guard shouldContinueSending(frameId: frameId, isKeyframe: isKeyframe) else {
                logBackpressureDrop(frameId: frameId, isKeyframe: isKeyframe)
                await sendGate.signal()
                return
            }
            let data = try envelope.encode()
            let packets = try MediaDatagramFramePacket.packetize(
                frameId: frameId,
                isKeyframe: isKeyframe,
                sentAtUptimeNs: envelope.header.capturedAtUptimeNs,
                payload: data,
                key: key
            )
            rememberFrame(frameId: frameId, packets: packets)
            let pacing = currentPacing()
            let shouldLogFrame = isKeyframe || frameId == 1 || frameId.isMultiple(of: 120)
            if shouldLogFrame {
                logger.notice("owned media quic send frame=\(frameId, privacy: .public) keyframe=\(isKeyframe, privacy: .public) bytes=\(data.count, privacy: .public) packets=\(packets.count, privacy: .public) burst=\(pacing.pacing.burstPacketCount, privacy: .public) pauseUs=\(pacing.pacing.burstPauseUs, privacy: .public) backpressure=\(pacing.isBackpressured, privacy: .public)")
            }
            for (index, packet) in packets.enumerated() {
                guard shouldContinueSending(frameId: frameId, isKeyframe: isKeyframe),
                      !isClosed else {
                    logBackpressureDrop(frameId: frameId, isKeyframe: isKeyframe)
                    await sendGate.signal()
                    return
                }
                try await sendDatagram(packet)
                if pacing.pacing.burstPauseUs > 0,
                   pacing.pacing.burstPacketCount > 0,
                   index + 1 < packets.count,
                   (index + 1).isMultiple(of: pacing.pacing.burstPacketCount) {
                    try await Task.sleep(nanoseconds: UInt64(pacing.pacing.burstPauseUs) * 1_000)
                }
            }
            let ordinal = noteSentFrame(frameId: frameId, bytes: data.count)
            if shouldLogFrame || ordinal == 1 || ordinal.isMultiple(of: 120) {
                logger.notice("owned media quic sent frame=\(frameId, privacy: .public) keyframe=\(isKeyframe, privacy: .public) packets=\(packets.count, privacy: .public)")
            }
            await sendGate.signal()
        } catch {
            await sendGate.signal()
            throw error
        }
    }

    func close() {
        guard markClosed() else { return }
        connection.cancel()
    }

    private var isClosed: Bool {
        stateQueue.sync { closed }
    }

    private func noteEnqueued(frameId: UInt64, isKeyframe: Bool) {
        stateQueue.sync {
            freshness.noteEnqueued(frameId: frameId, isKeyframe: isKeyframe)
        }
    }

    private func shouldContinueSending(frameId: UInt64, isKeyframe: Bool) -> Bool {
        stateQueue.sync {
            freshness.shouldSend(
                frameId: frameId,
                isKeyframe: isKeyframe,
                backpressure: backpressureConfig
            )
        }
    }

    private func noteSentFrame(frameId: UInt64, bytes: Int) -> UInt64 {
        stateQueue.sync {
            sentFrameCount &+= 1
            freshness.noteSent(frameId: frameId, bytes: bytes)
            return sentFrameCount
        }
    }

    private func currentPacing() -> (pacing: OwnedMediaDatagramPacing, isBackpressured: Bool) {
        stateQueue.sync {
            let isBackpressured = freshness.isClientBehind(backpressure: backpressureConfig)
            let pacing = OwnedMediaDatagramPacing.choose(
                isBackpressured: isBackpressured,
                normal: OwnedMediaDatagramPacing(
                    burstPacketCount: burstPacketCount,
                    burstPauseUs: burstPauseUs
                ),
                backpressure: OwnedMediaDatagramPacing(
                    burstPacketCount: backpressureBurstPacketCount,
                    burstPauseUs: backpressureBurstPauseUs
                )
            )
            return (pacing, isBackpressured)
        }
    }

    private func logBackpressureDrop(frameId: UInt64, isKeyframe: Bool) {
        let snapshot = stateQueue.sync {
            (
                inflightFrames: freshness.inFlightFrames.count,
                inflightBytes: freshness.inFlightFrames.values.reduce(0, +),
                renderGapMs: freshness.latestClientRenderGapMs,
                backlogFrames: freshness.latestClientBacklogFrames,
                backlogBytes: freshness.latestClientBacklogBytes,
                acked: freshness.latestAckedFrameId
            )
        }
        logger.notice("owned media quic drop frame=\(frameId, privacy: .public) keyframe=\(isKeyframe, privacy: .public) ack=\(snapshot.acked, privacy: .public) inflightFrames=\(snapshot.inflightFrames, privacy: .public) inflightBytes=\(snapshot.inflightBytes, privacy: .public) renderGapMs=\(snapshot.renderGapMs, privacy: .public) backlogFrames=\(snapshot.backlogFrames, privacy: .public) backlogBytes=\(snapshot.backlogBytes, privacy: .public)")
    }

    private func rememberFrame(frameId: UInt64, packets: [Data]) {
        stateQueue.sync {
            resendRing.remember(frameId: frameId, packets: packets)
        }
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

    private func receiveControlMessage() {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let error {
                self.logger.error("owned media quic control receive failed: \(String(describing: error), privacy: .public)")
                self.markClosed()
                return
            }
            guard !self.isClosed else { return }
            if let data, !data.isEmpty {
                do {
                    let message = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)
                    self.logger.notice("owned media quic control kind=\(message.kind.rawValue, privacy: .public) frame=\(message.frameId, privacy: .public)")
                    self.handleControlMessage(message)
                } catch {
                    self.logger.error("owned media quic control malformed bytes=\(data.count, privacy: .public): \(String(describing: error), privacy: .public)")
                }
            }
            self.receiveControlMessage()
        }
    }

    private func handleControlMessage(_ message: OwnedMediaControlMessage) {
        switch message.kind {
        case .keyframeRequest:
            onControlMessage(message)
        case .packetResendRequest:
            resendRequestedPackets(message)
        case .frameAck:
            noteFrameAck(message)
        }
    }

    private func noteFrameAck(_ message: OwnedMediaControlMessage) {
        let snapshot = stateQueue.sync {
            freshness.noteAck(
                frameId: message.frameId,
                renderGapMs: message.renderGapMs,
                clientBacklogFrames: message.clientBacklogFrames,
                clientBacklogBytes: message.clientBacklogBytes
            )
            return (
                inflightFrames: freshness.inFlightFrames.count,
                inflightBytes: freshness.inFlightFrames.values.reduce(0, +),
                renderGapMs: freshness.latestClientRenderGapMs,
                backlogFrames: freshness.latestClientBacklogFrames,
                backlogBytes: freshness.latestClientBacklogBytes,
                isBackpressured: freshness.isClientBehind(backpressure: backpressureConfig)
            )
        }
        let pacing = OwnedMediaDatagramPacing.choose(
            isBackpressured: snapshot.isBackpressured,
            normal: OwnedMediaDatagramPacing(
                burstPacketCount: burstPacketCount,
                burstPauseUs: burstPauseUs
            ),
            backpressure: OwnedMediaDatagramPacing(
                burstPacketCount: backpressureBurstPacketCount,
                burstPauseUs: backpressureBurstPauseUs
            )
        )
        logger.notice("owned media quic frame-ack frame=\(message.frameId, privacy: .public) total=\(message.totalFramesDecoded ?? 0, privacy: .public) renderGapMs=\(message.renderGapMs ?? 0, privacy: .public) backlogFrames=\(message.clientBacklogFrames ?? 0, privacy: .public) backlogBytes=\(message.clientBacklogBytes ?? 0, privacy: .public) inflightFrames=\(snapshot.inflightFrames, privacy: .public) inflightBytes=\(snapshot.inflightBytes, privacy: .public) backpressure=\(snapshot.isBackpressured, privacy: .public) pacingBurst=\(pacing.burstPacketCount, privacy: .public) pacingPauseUs=\(pacing.burstPauseUs, privacy: .public)")
    }

    private func resendRequestedPackets(_ message: OwnedMediaControlMessage) {
        let result = stateQueue.sync {
            resendRing.packets(
                frameId: message.frameId,
                indexes: message.packetIndexes,
                maxCount: maxResendPackets
            )
        }
        logger.notice("owned media quic resend-request frame=\(message.frameId, privacy: .public) requested=\(message.packetIndexes.count, privacy: .public) found=\(result.packets.count, privacy: .public) miss=\(result.misses.count, privacy: .public)")
        if !result.misses.isEmpty {
            logger.notice("owned media quic resend-miss frame=\(message.frameId, privacy: .public) packets=\(result.misses.count, privacy: .public)")
        }
        guard !result.packets.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            var sent = 0
            do {
                for (_, packet) in result.packets {
                    guard !self.isClosed else { return }
                    try await self.sendDatagram(packet)
                    sent += 1
                }
                self.logger.notice("owned media quic resend-sent frame=\(message.frameId, privacy: .public) packets=\(sent, privacy: .public)")
            } catch {
                self.logger.error("owned media quic resend failed frame=\(message.frameId, privacy: .public) sent=\(sent, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }
}

private actor DatagramSendGate {
    private var isBusy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if !isBusy {
            isBusy = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func signal() {
        if waiters.isEmpty {
            isBusy = false
        } else {
            waiters.removeFirst().resume()
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
              data[4] == version,
              data[5] == frameKind
        else {
            throw MediaDatagramPacketError.malformed
        }
        let payloadLength = Int(try data.readUInt16BE(at: 31))
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
        let packetCount = try data.readUInt16BE(at: 21)
        guard packetCount > 0 else { throw MediaDatagramPacketError.malformed }
        return MediaDatagramFramePacket(
            frameId: try data.readUInt64BE(at: 11),
            packetIndex: try data.readUInt16BE(at: 19),
            packetCount: packetCount,
            isKeyframe: (data[6] & keyframeFlag) != 0,
            sentAtUptimeNs: try data.readUInt64BE(at: 23),
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
