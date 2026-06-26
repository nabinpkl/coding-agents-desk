import Foundation

// ADR-0025 motion carrier: splits a frame's datagram packets into paced bursts so a
// large frame (170+ packets) does not flood the QUIC datagram send buffer in one tight
// loop, which on device manifested as dropped packets and cancelled sends. Pure
// decision logic; OwnedMediaVideoDatagramServer applies the pauses on its send queue.
struct OwnedMediaDatagramSendPacer: Equatable {
    let burstPacketCount: Int
    let burstPauseUs: Int

    init(burstPacketCount: Int, burstPauseUs: Int) {
        self.burstPacketCount = burstPacketCount
        self.burstPauseUs = burstPauseUs
    }

    // The half-open index ranges to send back-to-back. Consecutive bursts are separated
    // by pauseNanos. A non-positive burst size means no pacing: a single burst covering
    // every packet. An empty packet set yields no bursts.
    func bursts(packetCount: Int) -> [Range<Int>] {
        guard packetCount > 0 else { return [] }
        guard burstPacketCount > 0 else { return [0..<packetCount] }
        var ranges: [Range<Int>] = []
        var start = 0
        while start < packetCount {
            let end = min(start + burstPacketCount, packetCount)
            ranges.append(start..<end)
            start = end
        }
        return ranges
    }

    var pauseNanos: UInt64 { UInt64(max(0, burstPauseUs)) * 1_000 }
}
