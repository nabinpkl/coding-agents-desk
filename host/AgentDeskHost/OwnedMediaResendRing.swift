import Foundation

// Host side of datagram repair: the most recent frames' packets are retained so a
// client packet-resend-request can be served without re-encoding. A bounded ring
// by frameId; older frames evict. Revived from the pre-ADR-0022 carrier.
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
