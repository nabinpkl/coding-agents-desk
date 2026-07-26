import Foundation

// ADR-0025 motion carrier: splits a frame's datagram packets into paced bursts so a
// large frame (170+ packets) does not flood the QUIC datagram send buffer in one tight
// loop, which on device manifested as dropped packets and cancelled sends. Pure
// decision logic; QuicSessionHostMediaTransport applies the pauses on its send queue.
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

actor OwnedMediaDatagramBurstScheduler {
    typealias PacketSender = @Sendable (Data) async -> Bool

    private struct LiveJob {
        var bursts: [[Data]]
        let continuation: CheckedContinuation<Bool, Never>
    }

    private enum BurstKind {
        case live
        case repair
    }

    private let pacer: OwnedMediaDatagramSendPacer
    private let sendPacket: PacketSender
    private var liveJobs: [LiveJob] = []
    private var repairBursts: [[Data]] = []
    private var lastBurstKind: BurstKind?
    private var draining = false

    init(
        pacer: OwnedMediaDatagramSendPacer,
        sendPacket: @escaping PacketSender
    ) {
        self.pacer = pacer
        self.sendPacket = sendPacket
    }

    func sendLive(_ packets: [Data]) async -> Bool {
        guard !packets.isEmpty else { return true }
        return await withCheckedContinuation { continuation in
            liveJobs.append(
                LiveJob(
                    bursts: makeBursts(packets),
                    continuation: continuation
                )
            )
            startDrainIfNeeded()
        }
    }

    func enqueueRepair(_ packets: [Data]) {
        guard !packets.isEmpty else { return }
        repairBursts.append(contentsOf: makeBursts(packets))
        startDrainIfNeeded()
    }

    private func makeBursts(_ packets: [Data]) -> [[Data]] {
        pacer.bursts(packetCount: packets.count).map { Array(packets[$0]) }
    }

    private func startDrainIfNeeded() {
        guard !draining else { return }
        draining = true
        Task { await drain() }
    }

    private func drain() async {
        while let next = takeNextBurst() {
            for packet in next.packets {
                guard await sendPacket(packet) else {
                    failPendingLiveJobs()
                    repairBursts.removeAll()
                    lastBurstKind = nil
                    draining = false
                    return
                }
            }
            completeLiveJobIfNeeded(after: next.kind)
            if hasPendingWork, pacer.pauseNanos > 0 {
                try? await Task.sleep(nanoseconds: pacer.pauseNanos)
            }
        }
        lastBurstKind = nil
        draining = false
    }

    private var hasPendingWork: Bool {
        !liveJobs.isEmpty || !repairBursts.isEmpty
    }

    private func takeNextBurst() -> (kind: BurstKind, packets: [Data])? {
        let hasLive = !liveJobs.isEmpty
        let hasRepair = !repairBursts.isEmpty
        guard hasLive || hasRepair else { return nil }

        let kind: BurstKind
        if hasLive, hasRepair {
            kind = lastBurstKind == .repair ? .live : .repair
        } else {
            kind = hasRepair ? .repair : .live
        }
        lastBurstKind = kind
        switch kind {
        case .repair:
            return (.repair, repairBursts.removeFirst())
        case .live:
            return (.live, liveJobs[0].bursts.removeFirst())
        }
    }

    private func completeLiveJobIfNeeded(after kind: BurstKind) {
        guard kind == .live,
              !liveJobs.isEmpty,
              liveJobs[0].bursts.isEmpty else {
            return
        }
        let completed = liveJobs.removeFirst()
        completed.continuation.resume(returning: true)
    }

    private func failPendingLiveJobs() {
        let pending = liveJobs
        liveJobs.removeAll()
        for job in pending {
            job.continuation.resume(returning: false)
        }
    }
}
