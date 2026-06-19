import Foundation

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws
    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

protocol OwnedMediaChannelServing: AnyObject, Sendable {
    func send(_ envelope: OwnedMediaFrameEnvelope) async throws
    func close()
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
