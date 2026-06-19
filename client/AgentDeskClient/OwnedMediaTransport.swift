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
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.client.owned-media-datagram")
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
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: .udp)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media udp state=\(String(describing: state), privacy: .public)")
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
        while !Task.isCancelled {
            do {
                let data = try await receive(on: connection)
                let packet = try MediaDatagramFramePacket.decode(data, key: key)
                guard let frameData = assembler.accept(packet) else { continue }
                let envelope = try OwnedMediaFrameEnvelope.decode(frameData)
                await MainActor.run { [weak self] in
                    self?.sink?.renderOwnedMediaFrame(envelope)
                }
            } catch is CancellationError {
                return
            } catch {
                logger.error("owned media udp receive failed: \(String(describing: error), privacy: .public)")
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
}

private final class MediaDatagramFrameAssembler {
    private var frameId: UInt64 = 0
    private var packetCount: UInt16 = 0
    private var packets: [UInt16: Data] = [:]

    func accept(_ packet: MediaDatagramFramePacket) -> Data? {
        if packet.frameId < frameId {
            return nil
        }
        if packet.frameId > frameId {
            frameId = packet.frameId
            packetCount = packet.packetCount
            packets.removeAll(keepingCapacity: true)
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

private enum MediaDatagramPacketError: Error {
    case malformed
    case authenticationFailed
}

private struct MediaDatagramFramePacket: Equatable {
    private static let magic = Data([0x41, 0x44, 0x4d, 0x44])
    private static let version: UInt8 = 1
    private static let frameKind: UInt8 = 3
    private static let headerPrefixLength = 30
    private static let macLength = 32

    let frameId: UInt64
    let packetIndex: UInt16
    let packetCount: UInt16
    let sentAtUptimeNs: UInt64
    let payload: Data

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
