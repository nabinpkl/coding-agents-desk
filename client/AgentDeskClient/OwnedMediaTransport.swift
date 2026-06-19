import CryptoKit
import Foundation
import Network
import OSLog
import Security

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let host: String
    private let port: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant

    init(
        host: String,
        port: UInt16,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant
    ) {
        self.host = host
        self.port = port
        self.active = active
        self.mediaCapability = mediaCapability
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            host: host,
            port: port,
            active: active,
            mediaCapability: mediaCapability
        )
    }
}

final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    private static let quicALPN = "agentdesk-owned-media"
    private static let maxQuicDatagramBytes = 1_200
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.client.owned-media-quic")
    private let host: String
    private let port: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private var connection: NWConnection?
    private var receiveTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?

    init(
        host: String,
        port: UInt16,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant
    ) {
        self.host = host
        self.port = port
        self.active = active
        self.mediaCapability = mediaCapability
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws {
        guard let sink = videoSinks?[.detail] as? any OwnedMediaFrameSink else {
            throw MediaTransportError.notYetImplemented
        }
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            throw SessionRejected(reason: .malformed)
        }
        self.sink = sink
        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: endpointPort,
            using: Self.makeQuicDatagramParameters()
        )
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media quic state=\(String(describing: state), privacy: .public)")
            if case .failed = state {
                self?.stateContinuation.yield(.failed)
            }
        }
        stateContinuation.yield(.connecting)
        connection.start(queue: queue)

        let clientNonce = try Self.randomBytes(count: 32)
        let hello = MediaChannelHello(
            deviceFingerprint: active.deviceFingerprint,
            sessionId: active.sessionId,
            mediaCapability: mediaCapability.mediaCapability,
            clientNonce: clientNonce
        )
        try await send(JSONEncoder().encode(hello), on: connection)
        let ready = try await receiveReady(sessionId: active.sessionId, on: connection)
        let key = MediaDatagramCrypto.key(
            mediaCapability: mediaCapability.mediaCapability,
            clientNonce: clientNonce,
            serverNonce: ready.serverNonce
        )
        stateContinuation.yield(.connected)
        receiveTask = Task { [weak self, connection] in
            await self?.receiveLoop(connection: connection, key: key)
        }
    }

    func stop() {
        receiveTask?.cancel()
        receiveTask = nil
        connection?.cancel()
        connection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func receiveLoop(connection: NWConnection, key: SymmetricKey) async {
        let assembler = MediaDatagramFrameAssembler()
        var droppedPackets = 0
        var receivedPackets = 0
        var completedFrames = 0
        var skippedDeltasWaitingForKeyframe = 0
        var awaitingKeyframe = false
        while !Task.isCancelled {
            do {
                let data = try await receive(on: connection)
                let packet = try MediaDatagramFramePacket.decode(data, key: key)
                receivedPackets += 1
                if receivedPackets == 1 || receivedPackets.isMultiple(of: 600) {
                    logger.notice("owned media quic received packet count=\(receivedPackets, privacy: .public) frame=\(packet.frameId, privacy: .public) index=\(packet.packetIndex, privacy: .public)/\(packet.packetCount, privacy: .public) bytes=\(data.count, privacy: .public)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("quic packets=\(receivedPackets) frame=\(packet.frameId) index=\(packet.packetIndex)/\(packet.packetCount)\ncomplete=\(completedFrames) malformed=\(droppedPackets)")
                    }
                }
                if let droppedFrame = assembler.noteNewerFrameIfNeeded(packet) {
                    awaitingKeyframe = true
                    logger.error("owned media quic abandoned incomplete frame=\(droppedFrame.frameId, privacy: .public) received=\(droppedFrame.received, privacy: .public)/\(droppedFrame.expected, privacy: .public)")
                    try? await sendKeyframeRequest(afterFrameId: droppedFrame.frameId, on: connection)
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("abandoned frame=\(droppedFrame.frameId) received=\(droppedFrame.received)/\(droppedFrame.expected)\nquic packets=\(receivedPackets) complete=\(completedFrames)")
                    }
                }
                guard let frameData = assembler.accept(packet) else { continue }
                completedFrames += 1
                let envelope = try OwnedMediaFrameEnvelope.decode(frameData)
                if awaitingKeyframe, !envelope.header.isKeyframe {
                    skippedDeltasWaitingForKeyframe += 1
                    if skippedDeltasWaitingForKeyframe == 1 || skippedDeltasWaitingForKeyframe.isMultiple(of: 30) {
                        logger.notice("owned media quic skipped delta while waiting for keyframe count=\(skippedDeltasWaitingForKeyframe, privacy: .public) frame=\(envelope.header.frameId, privacy: .public)")
                        try? await sendKeyframeRequest(afterFrameId: envelope.header.frameId, on: connection)
                    }
                    continue
                }
                if envelope.header.isKeyframe {
                    awaitingKeyframe = false
                    skippedDeltasWaitingForKeyframe = 0
                }
                if completedFrames == 1 || completedFrames.isMultiple(of: 60) {
                    logger.notice("owned media quic completed frame count=\(completedFrames, privacy: .public) frame=\(packet.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) bytes=\(frameData.count, privacy: .public) packets=\(packet.packetCount, privacy: .public)")
                    ownedMediaStderrTrace("complete count=\(completedFrames) frame=\(packet.frameId) key=\(envelope.header.isKeyframe) bytes=\(frameData.count) packets=\(packet.packetCount) quic=\(receivedPackets) drops=\(droppedPackets)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("completed=\(completedFrames) frame=\(packet.frameId) key=\(envelope.header.isKeyframe) packets=\(packet.packetCount)\nquic packets=\(receivedPackets) malformed=\(droppedPackets)")
                    }
                }
                await MainActor.run { [weak self] in
                    self?.sink?.renderOwnedMediaFrame(envelope)
                }
            } catch is CancellationError {
                return
            } catch let error as MediaDatagramPacketError {
                droppedPackets += 1
                if droppedPackets == 1 || droppedPackets.isMultiple(of: 120) {
                    awaitingKeyframe = true
                    try? await sendKeyframeRequest(afterFrameId: 0, on: connection)
                    logger.error("owned media quic dropped packet count=\(droppedPackets, privacy: .public) reason=\(error.debugSummary, privacy: .public)")
                    await MainActor.run { [weak self] in
                        self?.sink?.setOwnedMediaDebugStatus("\(error.debugSummary)\ndrops=\(droppedPackets) quic=\(receivedPackets) complete=\(completedFrames)")
                    }
                }
                continue
            } catch {
                logger.error("owned media quic receive failed: \(String(describing: error), privacy: .public)")
                await MainActor.run { [weak self] in
                    self?.sink?.setOwnedMediaDebugStatus("receive failed \(String(describing: error))\nquic packets=\(receivedPackets) complete=\(completedFrames)")
                }
                stateContinuation.yield(.failed)
                return
            }
        }
    }

    private func send(_ data: Data, on connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private func sendKeyframeRequest(afterFrameId frameId: UInt64, on connection: NWConnection) async throws {
        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: frameId)
        let data = try JSONEncoder().encode(message)
        try await send(data, on: connection)
        logger.notice("owned media quic requested keyframe after frame=\(frameId, privacy: .public)")
    }

    private func receiveReady(sessionId: String, on connection: NWConnection) async throws -> MediaChannelReady {
        let data = try await receive(on: connection)
        let ready = try JSONDecoder().decode(MediaChannelReady.self, from: data)
        guard ready.sessionId == sessionId, !ready.serverNonce.isEmpty else {
            throw SessionRejected(reason: .malformed)
        }
        return ready
    }

    private func receive(on connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receiveMessage { data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: SessionRejected(reason: .malformed))
                }
            }
        }
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }

    private static func makeQuicDatagramParameters() -> NWParameters {
        let options = NWProtocolQUIC.Options(alpn: [Self.quicALPN])
        options.direction = .bidirectional
        options.isDatagram = true
        options.maxDatagramFrameSize = Self.maxQuicDatagramBytes
        #if DEBUG
        sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, _, complete in
            complete(true)
        }, DispatchQueue.main)
        #endif
        return NWParameters(quic: options)
    }
}

private func ownedMediaStderrTrace(_ message: String) {
    guard ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_STDERR_TRACE"] == "1",
          let data = "[owned-media] \(message)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}

private final class MediaDatagramFrameAssembler {
    private var frameId: UInt64 = 0
    private var packetCount: UInt16 = 0
    private var packets: [UInt16: Data] = [:]

    func noteNewerFrameIfNeeded(_ packet: MediaDatagramFramePacket) -> IncompleteFrame? {
        guard packet.frameId > frameId else { return nil }
        defer {
            frameId = packet.frameId
            packetCount = packet.packetCount
            packets.removeAll(keepingCapacity: true)
        }
        guard frameId > 0, packets.count < Int(packetCount) else { return nil }
        return IncompleteFrame(
            frameId: frameId,
            received: packets.count,
            expected: Int(packetCount)
        )
    }

    func accept(_ packet: MediaDatagramFramePacket) -> Data? {
        if packet.frameId < frameId {
            return nil
        }
        guard packet.packetCount == packetCount,
              packet.packetIndex < packetCount else {
            return nil
        }
        packets[packet.packetIndex] = packet.payload
        guard packets.count == Int(packetCount) else {
            return nil
        }
        var frame = Data()
        for index in UInt16(0)..<packetCount {
            guard let chunk = packets[index] else { return nil }
            frame.append(chunk)
        }
        packets.removeAll(keepingCapacity: true)
        return frame
    }
}

private struct IncompleteFrame {
    let frameId: UInt64
    let received: Int
    let expected: Int
}

private enum MediaDatagramPacketError: Error {
    case tooShort(length: Int, prefix: String)
    case badHeader(length: Int, prefix: String)
    case badLength(length: Int, expected: Int, payloadLength: Int)
    case badPacketCount
    case authenticationFailed(frameId: UInt64, packetIndex: UInt16, packetCount: UInt16)

    var debugSummary: String {
        switch self {
        case .tooShort(let length, let prefix):
            return "quic non-admd short len=\(length) prefix=\(prefix)"
        case .badHeader(let length, let prefix):
            return "quic non-admd header len=\(length) prefix=\(prefix)"
        case .badLength(let length, let expected, let payloadLength):
            return "quic bad length len=\(length) expected=\(expected) payload=\(payloadLength)"
        case .badPacketCount:
            return "quic bad packet count"
        case .authenticationFailed(let frameId, let packetIndex, let packetCount):
            return "quic auth failed frame=\(frameId) index=\(packetIndex)/\(packetCount)"
        }
    }
}

private struct MediaDatagramFramePacket: Equatable {
    private static let magic = Data([0x41, 0x44, 0x4d, 0x44])
    private static let version: UInt8 = 1
    private static let frameKind: UInt8 = 3
    private static let headerPrefixLength = 32
    private static let macLength = 32

    let frameId: UInt64
    let packetIndex: UInt16
    let packetCount: UInt16
    let sentAtUptimeNs: UInt64
    let payload: Data

    static func decode(_ data: Data, key: SymmetricKey) throws -> MediaDatagramFramePacket {
        guard data.count >= headerPrefixLength + macLength else {
            throw MediaDatagramPacketError.tooShort(length: data.count, prefix: data.hexPrefix())
        }
        guard data.prefix(4) == magic,
              data[4] == version,
              data[5] == frameKind
        else {
            throw MediaDatagramPacketError.badHeader(length: data.count, prefix: data.hexPrefix())
        }
        let payloadLength = Int(try data.readUInt16BE(at: 30))
        let expectedLength = headerPrefixLength + macLength + payloadLength
        guard data.count == expectedLength else {
            throw MediaDatagramPacketError.badLength(length: data.count, expected: expectedLength, payloadLength: payloadLength)
        }
        let payload = data.suffix(payloadLength)
        var authenticated = Data(data.prefix(headerPrefixLength))
        authenticated.append(payload)
        let expectedMac = HMAC<SHA256>.authenticationCode(for: authenticated, using: key)
        let actualMac = data.subdata(in: headerPrefixLength..<(headerPrefixLength + macLength))
        let packetCount = try data.readUInt16BE(at: 20)
        let packetIndex = try data.readUInt16BE(at: 18)
        let frameId = try data.readUInt64BE(at: 10)
        guard Data(expectedMac) == actualMac else {
            throw MediaDatagramPacketError.authenticationFailed(
                frameId: frameId,
                packetIndex: packetIndex,
                packetCount: packetCount
            )
        }
        guard packetCount > 0 else { throw MediaDatagramPacketError.badPacketCount }
        return MediaDatagramFramePacket(
            frameId: frameId,
            packetIndex: packetIndex,
            packetCount: packetCount,
            sentAtUptimeNs: try data.readUInt64BE(at: 22),
            payload: Data(payload)
        )
    }
}

private struct MediaDatagramCrypto {
    static func key(mediaCapability: String, clientNonce: Data, serverNonce: Data) -> SymmetricKey {
        var seed = Data("agentdesk-owned-media-datagram-v1".utf8)
        seed.append(Data(mediaCapability.utf8))
        seed.append(clientNonce)
        seed.append(serverNonce)
        let digest = SHA256.hash(data: seed)
        return SymmetricKey(data: Data(digest))
    }
}

private extension Data {
    func readUInt16BE(at offset: Int) throws -> UInt16 {
        guard count >= offset + 2 else {
            throw MediaDatagramPacketError.tooShort(length: count, prefix: hexPrefix())
        }
        return (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
    }

    func readUInt64BE(at offset: Int) throws -> UInt64 {
        guard count >= offset + 8 else {
            throw MediaDatagramPacketError.tooShort(length: count, prefix: hexPrefix())
        }
        var value: UInt64 = 0
        for index in offset..<(offset + 8) {
            value = (value << 8) | UInt64(self[index])
        }
        return value
    }

    func hexPrefix(byteCount: Int = 12) -> String {
        prefix(byteCount).map { String(format: "%02x", $0) }.joined()
    }
}
