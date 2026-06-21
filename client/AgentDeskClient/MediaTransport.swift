import CryptoKit
import Foundation
import UIKit

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws

    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed(SessionRejected?)
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaTransportError: Error {
    case notYetImplemented
}

struct ClientGraphicsConnectionPlan: Equatable {
    let host: String
    let port: UInt16
    let alpn: String
    let usesDatagrams: Bool

    init(
        host: String,
        port: UInt16 = Config.graphicsPort,
        alpn: String = ClientGraphicsChannelHandshake.quicALPN,
        usesDatagrams: Bool = false
    ) {
        self.host = host
        self.port = port
        self.alpn = alpn
        self.usesDatagrams = usesDatagrams
    }
}

struct GraphicsReconnectPolicy: Equatable, Sendable {
    let initialDelayMs: Int
    let maxDelayMs: Int
    let maxAttempts: Int

    func delayMs(forAttempt attempt: Int) -> Int? {
        guard attempt > 0, attempt <= maxAttempts else { return nil }
        let shift = min(attempt - 1, 12)
        let multiplied = initialDelayMs.multipliedReportingOverflow(by: 1 << shift)
        let uncapped = multiplied.overflow ? maxDelayMs : multiplied.partialValue
        return min(max(uncapped, initialDelayMs), maxDelayMs)
    }
}

enum ClientGraphicsChannelHandshake {
    static let quicALPN = "agentdesk-owned-graphics"

    static func graphicsCapability(from mediaCapability: String) -> String {
        mediaCapability
    }

    static func makeHello(
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        clientNonce: Data
    ) -> GraphicsChannelHello {
        GraphicsChannelHello(
            deviceFingerprint: active.deviceFingerprint,
            sessionId: active.sessionId,
            graphicsCapability: graphicsCapability(from: mediaCapability.mediaCapability),
            clientNonce: clientNonce
        )
    }

    static func validateReady(
        _ ready: GraphicsChannelReady,
        expectedSessionId: String
    ) throws -> GraphicsChannelReady {
        guard ready.type == "graphics-ready",
              ready.sessionId == expectedSessionId,
              !ready.serverNonce.isEmpty else {
            throw SessionRejected(reason: .malformed)
        }
        return ready
    }
}

final class MediaDatagramFrameRepairBuffer {
    private struct PendingFrame {
        let frameId: UInt64
        let packetCount: UInt16
        let isKeyframe: Bool
        let firstSeenNs: UInt64
        var packets: [UInt16: Data]
        var repairDeadlineNs: UInt64?
        var repairRequestedAtNs: UInt64?

        var isComplete: Bool {
            packets.count == Int(packetCount)
        }

        var missingIndexes: [UInt16] {
            (UInt16(0)..<packetCount).filter { packets[$0] == nil }
        }

        var incompleteFrame: IncompleteFrame {
            IncompleteFrame(
                frameId: frameId,
                isKeyframe: isKeyframe,
                received: packets.count,
                expected: Int(packetCount),
                missingIndexes: missingIndexes
            )
        }

        func incompleteFrame(now: UInt64) -> IncompleteFrame {
            IncompleteFrame(
                frameId: frameId,
                isKeyframe: isKeyframe,
                received: packets.count,
                expected: Int(packetCount),
                missingIndexes: missingIndexes,
                firstSeenAgeNs: now &- firstSeenNs,
                repairAgeNs: repairRequestedAtNs.map { now &- $0 }
            )
        }

        var receivedBytes: Int {
            packets.values.reduce(0) { $0 + $1.count }
        }

        func completedFrame(now: UInt64) -> MediaDatagramCompletedFrame? {
            guard isComplete else { return nil }
            var frame = Data()
            for index in UInt16(0)..<packetCount {
                guard let packet = packets[index] else { return nil }
                frame.append(packet)
            }
            return MediaDatagramCompletedFrame(
                frameId: frameId,
                packetCount: packetCount,
                data: frame,
                wasRepaired: repairDeadlineNs != nil,
                firstSeenAgeNs: now &- firstSeenNs,
                repairedAfterNs: repairRequestedAtNs.map { now &- $0 }
            )
        }

        func isLateRepairedDelta(now: UInt64) -> Bool {
            guard !isKeyframe,
                  repairRequestedAtNs != nil,
                  let repairDeadlineNs else {
                return false
            }
            return now >= repairDeadlineNs
        }
    }

    private let repairDeadlineNs: UInt64
    private let trackedFrameLimit: Int
    private let maxResendPackets: Int
    private var newestFrameId: UInt64 = 0
    private var deliveredFrameId: UInt64 = 0
    private var frames: [UInt64: PendingFrame] = [:]

    init(repairDeadlineNs: UInt64, trackedFrameLimit: Int, maxResendPackets: Int) {
        self.repairDeadlineNs = repairDeadlineNs
        self.trackedFrameLimit = max(1, trackedFrameLimit)
        self.maxResendPackets = max(1, maxResendPackets)
    }

    var debugSnapshot: MediaDatagramRepairDebugSnapshot {
        MediaDatagramRepairDebugSnapshot(
            trackedFrameCount: frames.count,
            trackedBytes: frames.values.reduce(0) { $0 + $1.receivedBytes },
            newestFrameId: newestFrameId,
            deliveredFrameId: deliveredFrameId,
            missingPacketTotal: frames.values.reduce(0) { $0 + $1.missingIndexes.count }
        )
    }

    func accept(
        _ packet: MediaDatagramFramePacket,
        now: UInt64
    ) -> MediaDatagramRepairResult {
        guard packet.packetIndex < packet.packetCount,
              packet.frameId > deliveredFrameId else {
            return .empty
        }
        newestFrameId = max(newestFrameId, packet.frameId)
        if var pending = frames[packet.frameId] {
            guard pending.packetCount == packet.packetCount,
                  pending.isKeyframe == packet.isKeyframe else {
                return expire(frameId: packet.frameId)
            }
            pending.packets[packet.packetIndex] = packet.payload
            frames[packet.frameId] = pending
        } else {
            frames[packet.frameId] = PendingFrame(
                frameId: packet.frameId,
                packetCount: packet.packetCount,
                isKeyframe: packet.isKeyframe,
                firstSeenNs: now,
                packets: [packet.packetIndex: packet.payload],
                repairDeadlineNs: nil,
                repairRequestedAtNs: nil
            )
        }

        var result = MediaDatagramRepairResult.empty
        result.resendRequests.append(contentsOf: requestMissingPackets(now: now))
        let expired = expirePastDeadline(now: now)
        result.expiredFrames.append(contentsOf: expired.filter(\.isKeyframe))
        result.skippedStaleFrames.append(contentsOf: expired.filter { !$0.isKeyframe })
        result.expiredFrames.append(contentsOf: enforceTrackedFrameLimit())
        let drained = drainCompletedFrames(now: now)
        result.skippedStaleFrames.append(contentsOf: drained.skippedStaleFrames)
        result.repairedFrameCount += drained.completedFrames.filter(\.wasRepaired).count
        result.completedFrames.append(contentsOf: drained.completedFrames)
        return result
    }

    private func requestMissingPackets(now: UInt64) -> [MediaDatagramRepairRequest] {
        var requests: [MediaDatagramRepairRequest] = []
        for frameId in frames.keys.sorted() {
            guard frameId < newestFrameId,
                  var pending = frames[frameId],
                  !pending.isComplete,
                  pending.repairDeadlineNs == nil
            else {
                continue
            }
            let missing = Array(pending.missingIndexes.prefix(maxResendPackets))
            guard !missing.isEmpty else { continue }
            pending.repairDeadlineNs = now + repairDeadlineNs
            pending.repairRequestedAtNs = now
            frames[frameId] = pending
            requests.append(MediaDatagramRepairRequest(
                frameId: frameId,
                packetIndexes: missing,
                requestedAtNs: now,
                firstSeenAgeNs: now &- pending.firstSeenNs
            ))
        }
        return requests
    }

    private func expirePastDeadline(now: UInt64) -> [IncompleteFrame] {
        let expiredIds = frames.keys.sorted().filter { frameId in
            guard let frame = frames[frameId],
                  !frame.isComplete,
                  let deadline = frame.repairDeadlineNs else {
                return false
            }
            return now >= deadline
        }
        return expiredIds.compactMap { frameId in
            guard let frame = frames.removeValue(forKey: frameId) else { return nil }
            deliveredFrameId = max(deliveredFrameId, frameId)
            return frame.incompleteFrame(now: now)
        }
    }

    private func enforceTrackedFrameLimit() -> [IncompleteFrame] {
        var expired: [IncompleteFrame] = []
        while frames.count > trackedFrameLimit, let oldest = frames.keys.sorted().first {
            guard let frame = frames.removeValue(forKey: oldest) else { continue }
            deliveredFrameId = max(deliveredFrameId, oldest)
            if !frame.isComplete {
                expired.append(frame.incompleteFrame(now: DispatchTime.now().uptimeNanoseconds))
            }
        }
        return expired
    }

    private func drainCompletedFrames(now: UInt64) -> MediaDatagramDrainResult {
        var completed: [MediaDatagramCompletedFrame] = []
        var skippedStaleFrames: [IncompleteFrame] = []
        while let nextId = frames.keys.sorted().first,
              let frame = frames[nextId] {
            if frame.isComplete, frame.isLateRepairedDelta(now: now) {
                frames.removeValue(forKey: nextId)
                deliveredFrameId = max(deliveredFrameId, nextId)
                skippedStaleFrames.append(frame.incompleteFrame(now: now))
                continue
            }
            guard frame.isComplete, let completedFrame = frame.completedFrame(now: now) else {
                break
            }
            frames.removeValue(forKey: nextId)
            deliveredFrameId = max(deliveredFrameId, nextId)
            completed.append(completedFrame)
        }
        return MediaDatagramDrainResult(
            completedFrames: completed,
            skippedStaleFrames: skippedStaleFrames
        )
    }

    private func expire(frameId: UInt64) -> MediaDatagramRepairResult {
        guard let frame = frames.removeValue(forKey: frameId) else {
            return .empty
        }
        deliveredFrameId = max(deliveredFrameId, frameId)
        return MediaDatagramRepairResult(
            resendRequests: [],
            completedFrames: [],
            expiredFrames: [frame.incompleteFrame],
            skippedStaleFrames: [],
            repairedFrameCount: 0
        )
    }
}

struct MediaDatagramRepairDebugSnapshot: Equatable {
    let trackedFrameCount: Int
    let trackedBytes: Int
    let newestFrameId: UInt64
    let deliveredFrameId: UInt64
    let missingPacketTotal: Int

    var traceFields: String {
        "trackedFrames=\(trackedFrameCount) trackedBytes=\(trackedBytes) newest=\(newestFrameId) delivered=\(deliveredFrameId) missingPackets=\(missingPacketTotal)"
    }
}

struct MediaDatagramRepairRequest: Equatable {
    let frameId: UInt64
    let packetIndexes: [UInt16]
    let requestedAtNs: UInt64
    let firstSeenAgeNs: UInt64

    init(
        frameId: UInt64,
        packetIndexes: [UInt16],
        requestedAtNs: UInt64 = 0,
        firstSeenAgeNs: UInt64 = 0
    ) {
        self.frameId = frameId
        self.packetIndexes = packetIndexes
        self.requestedAtNs = requestedAtNs
        self.firstSeenAgeNs = firstSeenAgeNs
    }
}

struct MediaDatagramCompletedFrame: Equatable {
    let frameId: UInt64
    let packetCount: UInt16
    let data: Data
    let wasRepaired: Bool
    let firstSeenAgeNs: UInt64
    let repairedAfterNs: UInt64?

    init(
        frameId: UInt64,
        packetCount: UInt16,
        data: Data,
        wasRepaired: Bool,
        firstSeenAgeNs: UInt64 = 0,
        repairedAfterNs: UInt64? = nil
    ) {
        self.frameId = frameId
        self.packetCount = packetCount
        self.data = data
        self.wasRepaired = wasRepaired
        self.firstSeenAgeNs = firstSeenAgeNs
        self.repairedAfterNs = repairedAfterNs
    }
}

struct MediaDatagramRepairResult: Equatable {
    var resendRequests: [MediaDatagramRepairRequest]
    var completedFrames: [MediaDatagramCompletedFrame]
    var expiredFrames: [IncompleteFrame]
    var skippedStaleFrames: [IncompleteFrame]
    var repairedFrameCount: Int

    static let empty = MediaDatagramRepairResult(
        resendRequests: [],
        completedFrames: [],
        expiredFrames: [],
        skippedStaleFrames: [],
        repairedFrameCount: 0
    )
}

private struct MediaDatagramDrainResult {
    let completedFrames: [MediaDatagramCompletedFrame]
    let skippedStaleFrames: [IncompleteFrame]
}

struct IncompleteFrame: Equatable {
    let frameId: UInt64
    let isKeyframe: Bool
    let received: Int
    let expected: Int
    let missingIndexes: [UInt16]
    let firstSeenAgeNs: UInt64
    let repairAgeNs: UInt64?

    init(
        frameId: UInt64,
        isKeyframe: Bool = false,
        received: Int,
        expected: Int,
        missingIndexes: [UInt16],
        firstSeenAgeNs: UInt64 = 0,
        repairAgeNs: UInt64? = nil
    ) {
        self.frameId = frameId
        self.isKeyframe = isKeyframe
        self.received = received
        self.expected = expected
        self.missingIndexes = missingIndexes
        self.firstSeenAgeNs = firstSeenAgeNs
        self.repairAgeNs = repairAgeNs
    }
}

enum MediaDatagramPacketError: Error {
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

struct MediaDatagramFramePacket: Equatable {
    private static let magic = Data([0x41, 0x44, 0x4d, 0x44])
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
        let payloadLength = Int(try data.readUInt16BE(at: 31))
        let expectedLength = headerPrefixLength + macLength + payloadLength
        guard data.count == expectedLength else {
            throw MediaDatagramPacketError.badLength(length: data.count, expected: expectedLength, payloadLength: payloadLength)
        }
        let payload = data.suffix(payloadLength)
        var authenticated = Data(data.prefix(headerPrefixLength))
        authenticated.append(payload)
        let expectedMac = HMAC<SHA256>.authenticationCode(for: authenticated, using: key)
        let actualMac = data.subdata(in: headerPrefixLength..<(headerPrefixLength + macLength))
        let packetCount = try data.readUInt16BE(at: 21)
        let packetIndex = try data.readUInt16BE(at: 19)
        let frameId = try data.readUInt64BE(at: 11)
        let flags = data[6]
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
            isKeyframe: (flags & keyframeFlag) != 0,
            sentAtUptimeNs: try data.readUInt64BE(at: 23),
            payload: Data(payload)
        )
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

// VideoFrameSource is the host-side capture seam. The client mirror exists
// so MediaTransport.start can carry one signature on both sides; the
// client never instantiates a source.
protocol VideoFrameSource: AnyObject, Sendable {
    func start() async throws
    func stop()
}

protocol VideoFrameSink: AnyObject, Sendable {
    @MainActor var view: UIView { get }
}
