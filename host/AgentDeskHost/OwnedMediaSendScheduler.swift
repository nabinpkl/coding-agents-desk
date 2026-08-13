import Foundation

/// ADR-0098: the one place video bytes reach the wire, and the one place they are rate-limited.
///
/// Every datagram the media path emits passes through here -- live frames via `sendLive`, repair
/// packets via `enqueueRepair` -- so it is the only seam where a budget can be enforced over all
/// of them at once. That matters: repair traffic used to compete with live video for the same
/// starved link with no shared accounting at all, which is the worst possible time for it, since
/// repair is requested precisely when the link is already failing.
///
/// Pacing is per packet rather than per burst. The fixed 32-packet/1ms grouping this replaces was
/// a second mechanism for the same job as the token bucket, and a worse one: it bounded how many
/// packets went out back-to-back but never how many bytes, so a keyframe's 92 packets left in
/// about 2ms. One mechanism, at the granularity where the size is actually known.
actor OwnedMediaSendScheduler {
    typealias PacketSender = @Sendable (Data) async -> Bool

    private struct LiveJob {
        var packets: [Data]
        let continuation: CheckedContinuation<Bool, Never>
    }

    private enum Source {
        case live
        case repair
    }

    private var pacer: LinkSendPacer
    private let sendPacket: PacketSender
    private var liveJobs: [LiveJob] = []
    private var repairPackets: [Data] = []
    private var lastSource: Source?
    private var draining = false

    init(
        pacer: LinkSendPacer,
        sendPacket: @escaping PacketSender
    ) {
        self.pacer = pacer
        self.sendPacket = sendPacket
    }

    /// Adopt the quality ladder's current budget.
    ///
    /// Called from the same place the encoder's bitrate is set, so the wire and the encoder are
    /// always working to one number.
    func retarget(bytesPerSecond: Double) {
        pacer.retarget(bytesPerSecond: bytesPerSecond, nowNs: DispatchTime.now().uptimeNanoseconds)
    }

    /// Put a frame's packets on the wire, returning once the last one is gone.
    ///
    /// The caller awaiting this is load-bearing rather than incidental: the encode drain awaits
    /// it, so a frame that takes real time to pace holds off the next encode instead of piling
    /// captures behind it. That is the backpressure the path wanted all along -- previously the
    /// send returned almost immediately and the queue formed out on the link, where nothing
    /// could see it.
    func sendLive(_ packets: [Data]) async -> Bool {
        guard !packets.isEmpty else { return true }
        return await withCheckedContinuation { continuation in
            liveJobs.append(LiveJob(packets: packets, continuation: continuation))
            startDrainIfNeeded()
        }
    }

    func enqueueRepair(_ packets: [Data]) {
        guard !packets.isEmpty else { return }
        repairPackets.append(contentsOf: packets)
        startDrainIfNeeded()
    }

    private func startDrainIfNeeded() {
        guard !draining else { return }
        draining = true
        Task { await drain() }
    }

    private func drain() async {
        while let next = takeNextPacket() {
            let waitNs = pacer.waitNanos(
                forBytes: next.packet.count,
                nowNs: DispatchTime.now().uptimeNanoseconds
            )
            if waitNs > 0 {
                // Suspends the drain, not the actor: `sendLive` and `enqueueRepair` still run
                // while this waits, which is what lets a newer frame queue behind a slow one.
                try? await Task.sleep(nanoseconds: waitNs)
            }
            pacer.consume(
                bytes: next.packet.count,
                nowNs: DispatchTime.now().uptimeNanoseconds
            )
            guard await sendPacket(next.packet) else {
                failPendingLiveJobs()
                repairPackets.removeAll()
                lastSource = nil
                draining = false
                return
            }
            completeLiveJobIfNeeded(after: next.source)
        }
        lastSource = nil
        draining = false
    }

    /// Alternates live and repair while both are waiting, so neither can starve the other.
    private func takeNextPacket() -> (source: Source, packet: Data)? {
        let hasLive = !liveJobs.isEmpty
        let hasRepair = !repairPackets.isEmpty
        guard hasLive || hasRepair else { return nil }

        let source: Source
        if hasLive, hasRepair {
            source = lastSource == .repair ? .live : .repair
        } else {
            source = hasRepair ? .repair : .live
        }
        lastSource = source
        switch source {
        case .repair:
            return (.repair, repairPackets.removeFirst())
        case .live:
            return (.live, liveJobs[0].packets.removeFirst())
        }
    }

    private func completeLiveJobIfNeeded(after source: Source) {
        guard source == .live,
              !liveJobs.isEmpty,
              liveJobs[0].packets.isEmpty else {
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
