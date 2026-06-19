import Foundation

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws
    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

protocol OwnedMediaChannelServing: AnyObject, Sendable {
    func send(_ envelope: OwnedMediaFrameEnvelope) async throws -> OwnedMediaSendStats
    func close()
}

struct OwnedMediaSendStats: Equatable, Sendable {
    let frameId: UInt64
    let encodedBytes: Int
    let packetCount: Int
    let sendStartUptimeNs: UInt64
    let sendEndUptimeNs: UInt64
    let burstPauseCount: Int
    let maxInterPacketGapMs: Double
    let pacingBurstPacketCount: Int
    let pacingBurstPauseUs: Int
    let isBackpressured: Bool

    var sendDurationMs: Double {
        guard sendEndUptimeNs >= sendStartUptimeNs else { return 0 }
        return Double(sendEndUptimeNs - sendStartUptimeNs) / 1_000_000.0
    }
}

struct OwnedMediaDiagnosticsFpsWindow: Equatable {
    private(set) var windowStartedAtUptimeNs: UInt64
    private(set) var captured = 0
    private(set) var admitted = 0
    private(set) var encoded = 0
    private(set) var sent = 0
    private(set) var acked = 0

    init(windowStartedAtUptimeNs: UInt64) {
        self.windowStartedAtUptimeNs = windowStartedAtUptimeNs
    }

    mutating func incrementCaptured() { captured += 1 }
    mutating func incrementAdmitted() { admitted += 1 }
    mutating func incrementEncoded() { encoded += 1 }
    mutating func incrementSent() { sent += 1 }
    mutating func incrementAcked() { acked += 1 }

    mutating func flushIfDue(nowUptimeNs: UInt64) -> OwnedMediaDiagnosticsFpsSample? {
        guard nowUptimeNs >= windowStartedAtUptimeNs,
              nowUptimeNs - windowStartedAtUptimeNs >= 1_000_000_000
        else {
            return nil
        }
        let elapsedSeconds = max(Double(nowUptimeNs - windowStartedAtUptimeNs) / 1_000_000_000.0, 0.001)
        let sample = OwnedMediaDiagnosticsFpsSample(
            elapsedSeconds: elapsedSeconds,
            captured: captured,
            admitted: admitted,
            encoded: encoded,
            sent: sent,
            acked: acked
        )
        windowStartedAtUptimeNs = nowUptimeNs
        captured = 0
        admitted = 0
        encoded = 0
        sent = 0
        acked = 0
        return sample
    }
}

struct OwnedMediaDiagnosticsFpsSample: Equatable {
    let elapsedSeconds: Double
    let captured: Int
    let admitted: Int
    let encoded: Int
    let sent: Int
    let acked: Int

    func fps(_ count: Int) -> Double {
        Double(count) / elapsedSeconds
    }
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

enum MediaTransportError: Error {
    case notYetImplemented
}

struct OwnedMediaResendRing {
    private let capacityFrames: Int
    private var frames: [UInt64: [UInt16: Data]] = [:]
    private var order: [UInt64] = []

    init(capacityFrames: Int) {
        self.capacityFrames = max(1, capacityFrames)
    }

    mutating func remember(frameId: UInt64, packets: [Data]) {
        var packetMap: [UInt16: Data] = [:]
        packetMap.reserveCapacity(packets.count)
        for (index, packet) in packets.enumerated() where index <= Int(UInt16.max) {
            packetMap[UInt16(index)] = packet
        }
        if frames[frameId] == nil {
            order.append(frameId)
        }
        frames[frameId] = packetMap
        while order.count > capacityFrames {
            let evicted = order.removeFirst()
            frames.removeValue(forKey: evicted)
        }
    }

    func packets(frameId: UInt64, indexes: [UInt16], maxCount: Int) -> (packets: [(UInt16, Data)], misses: [UInt16]) {
        guard maxCount > 0 else {
            return ([], indexes)
        }
        let uniqueIndexes = Array(Set(indexes)).sorted()
        guard let stored = frames[frameId] else {
            return ([], Array(uniqueIndexes.prefix(maxCount)))
        }
        var packets: [(UInt16, Data)] = []
        var misses: [UInt16] = []
        packets.reserveCapacity(min(uniqueIndexes.count, maxCount))
        for index in uniqueIndexes.prefix(maxCount) {
            if let packet = stored[index] {
                packets.append((index, packet))
            } else {
                misses.append(index)
            }
        }
        return (packets, misses)
    }
}

protocol VideoFrameSink: AnyObject, Sendable {}
