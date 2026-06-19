import CryptoKit
import Foundation

// ADR-0004 protocol seam. Mirror of host/AgentDeskHost/MediaTransport.swift.
// The only files that import WebRTC are the LibWebRTC* impls; PairingClient
// holds a MediaTransportFactory by protocol.

protocol MediaTransport: AnyObject, Sendable {
    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws

    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

enum MediaTransportRole {
    case offerer
    case answerer
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaPlane: String, CaseIterable, Equatable, Hashable, Codable {
    case detail
    case motion

    var trackId: String {
        switch self {
        case .detail: "detail-video"
        case .motion: "motion-video"
        }
    }

    var streamId: String {
        switch self {
        case .detail: "detail"
        case .motion: "motion"
        }
    }

    init?(trackId: String) {
        guard let plane = Self.allCases.first(where: { $0.trackId == trackId }) else {
            return nil
        }
        self = plane
    }
}

struct VideoPlaneSources: Sendable {
    private let sources: [MediaPlane: VideoFrameSource]

    init(_ sources: [MediaPlane: VideoFrameSource]) {
        self.sources = sources
    }

    subscript(_ plane: MediaPlane) -> VideoFrameSource? {
        sources[plane]
    }
}

struct VideoPlaneSinks: Sendable {
    private let sinks: [MediaPlane: VideoFrameSink]

    init(_ sinks: [MediaPlane: VideoFrameSink]) {
        self.sinks = sinks
    }

    subscript(_ plane: MediaPlane) -> VideoFrameSink? {
        sinks[plane]
    }
}

struct MediaCodecPreferences: Equatable {
    var preferred: [VideoCodec]

    enum VideoCodec: String, Equatable, Codable {
        case h264
        case h265
        case vp8
        case vp9
        case av1
    }

    static let h264Only = MediaCodecPreferences(preferred: [.h264])
    static let vp9Only = MediaCodecPreferences(preferred: [.vp9])
    static let vp9First = MediaCodecPreferences(preferred: [.vp9, .h264])

    static let defaultPlanes: [MediaPlane: MediaCodecPreferences] = [
        .detail: .vp9Only,
        .motion: .vp9First
    ]

    var preferredCodecNames: [String] {
        preferred.map { codec in
            switch codec {
            case .h264: return "H264"
            case .h265: return "H265"
            case .vp8: return "VP8"
            case .vp9: return "VP9"
            case .av1: return "AV1"
            }
        }
    }

    func allows(statsMimeType: String) -> Bool {
        guard let subtype = statsMimeType.split(separator: "/").last else { return false }
        return preferredCodecNames.contains(String(subtype).uppercased())
    }
}

struct CodecCapabilityDescriptor: Equatable {
    let index: Int
    let name: String
    let preferredPayloadType: String?
    let aptPayloadType: String?
}

enum CodecPreferencePolicy {
    private static let primaryNames: Set<String> = ["H264", "H265", "VP8", "VP9", "AV1"]
    private static let protectionNames: Set<String> = ["RED", "ULPFEC", "FLEXFEC-03"]

    static func orderedAllowedIndexes(
        capabilities: [CodecCapabilityDescriptor],
        preferences: MediaCodecPreferences
    ) -> [Int] {
        var selectedMedia: [CodecCapabilityDescriptor] = []
        for name in preferences.preferredCodecNames {
            selectedMedia.append(
                contentsOf: capabilities.filter {
                    normalize($0.name) == name && isPrimary($0)
                }
            )
        }

        let mediaAndRepairIndexes = selectedMedia.flatMap { media -> [Int] in
            let repairIndexes = media.preferredPayloadType.map { payloadType in
                capabilities
                    .filter { isRtx($0) && $0.aptPayloadType == payloadType }
                    .map(\.index)
            } ?? []
            return [media.index] + repairIndexes
        }
        let protectionIndexes = capabilities
            .filter(isProtection)
            .map(\.index)
        return unique(mediaAndRepairIndexes + protectionIndexes)
    }

    private static func isPrimary(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        primaryNames.contains(normalize(descriptor.name))
    }

    private static func isRtx(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        normalize(descriptor.name) == "RTX"
    }

    private static func isProtection(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        protectionNames.contains(normalize(descriptor.name))
    }

    private static func normalize(_ name: String) -> String {
        name.uppercased()
    }

    private static func unique(_ indexes: [Int]) -> [Int] {
        indexes.reduce([]) { ordered, index in
            ordered.contains(index) ? ordered : ordered + [index]
        }
    }
}

enum MediaTransportError: Error {
    case notYetImplemented
    case unsupportedCodecPreference(String)
}

final class MediaDatagramFrameRepairBuffer {
    private struct PendingFrame {
        let frameId: UInt64
        let packetCount: UInt16
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
                received: packets.count,
                expected: Int(packetCount),
                missingIndexes: missingIndexes
            )
        }

        func incompleteFrame(now: UInt64) -> IncompleteFrame {
            IncompleteFrame(
                frameId: frameId,
                received: packets.count,
                expected: Int(packetCount),
                missingIndexes: missingIndexes,
                firstSeenAgeNs: now &- firstSeenNs,
                repairAgeNs: repairRequestedAtNs.map { now &- $0 }
            )
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

    func accept(
        _ packet: MediaDatagramFramePacket,
        now: UInt64,
        motionActive: Bool = false
    ) -> MediaDatagramRepairResult {
        guard packet.packetIndex < packet.packetCount,
              packet.frameId > deliveredFrameId else {
            return .empty
        }
        newestFrameId = max(newestFrameId, packet.frameId)
        if var pending = frames[packet.frameId] {
            guard pending.packetCount == packet.packetCount else {
                return expire(frameId: packet.frameId)
            }
            pending.packets[packet.packetIndex] = packet.payload
            frames[packet.frameId] = pending
        } else {
            frames[packet.frameId] = PendingFrame(
                frameId: packet.frameId,
                packetCount: packet.packetCount,
                firstSeenNs: now,
                packets: [packet.packetIndex: packet.payload],
                repairDeadlineNs: nil,
                repairRequestedAtNs: nil
            )
        }

        var result = MediaDatagramRepairResult.empty
        result.resendRequests.append(contentsOf: requestMissingPackets(now: now))
        if motionActive {
            result.skippedStaleFrames.append(contentsOf: skipStaleMotionFrames(now: now))
        } else {
            result.expiredFrames.append(contentsOf: expirePastDeadline(now: now))
        }
        result.expiredFrames.append(contentsOf: enforceTrackedFrameLimit())
        let completed = drainCompletedFrames(now: now)
        result.repairedFrameCount += completed.filter(\.wasRepaired).count
        result.completedFrames.append(contentsOf: completed)
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

    private func skipStaleMotionFrames(now: UInt64) -> [IncompleteFrame] {
        let staleIds = frames.keys.sorted().filter { frameId in
            guard let frame = frames[frameId],
                  !frame.isComplete,
                  let deadline = frame.repairDeadlineNs else {
                return false
            }
            return now >= deadline
        }
        return staleIds.compactMap { frameId in
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

    private func drainCompletedFrames(now: UInt64) -> [MediaDatagramCompletedFrame] {
        var completed: [MediaDatagramCompletedFrame] = []
        while let nextId = frames.keys.sorted().first,
              let frame = frames[nextId] {
            guard frame.isComplete, let completedFrame = frame.completedFrame(now: now) else {
                break
            }
            frames.removeValue(forKey: nextId)
            deliveredFrameId = max(deliveredFrameId, nextId)
            completed.append(completedFrame)
        }
        return completed
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

struct IncompleteFrame: Equatable {
    let frameId: UInt64
    let received: Int
    let expected: Int
    let missingIndexes: [UInt16]
    let firstSeenAgeNs: UInt64
    let repairAgeNs: UInt64?

    init(
        frameId: UInt64,
        received: Int,
        expected: Int,
        missingIndexes: [UInt16],
        firstSeenAgeNs: UInt64 = 0,
        repairAgeNs: UInt64? = nil
    ) {
        self.frameId = frameId
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

// VideoFrameSink is declared in its own file but the protocol surface
// here keeps MediaTransport.start's signature symmetric with the host.
// On the client, concrete impls (RTCMTLVideoSink) live alongside the
// concrete transport.
