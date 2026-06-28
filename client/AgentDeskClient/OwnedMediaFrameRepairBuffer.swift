import Foundation

// Client side of datagram repair for the mixed-mode renderer (ADR-0025). Packets
// arrive out of order and lossy; this buffers by frameId, delivers a frame's bytes
// in index order once complete, and for a frame that a newer frame has overtaken
// while still missing packets it emits a resend request (bounded by maxResendPackets)
// and arms a repair deadline. Past the deadline an unrepaired frame is dropped as an
// IncompleteFrame, which the transport turns into a keyframe request so the stream
// re-synchronises. Revived from the pre-ADR-0022 carrier.
final class MediaDatagramFrameRepairBuffer {
    private struct PendingFrame {
        let frameId: UInt64
        let packetCount: UInt16
        var packets: [UInt16: Data]
        var repairDeadlineNs: UInt64?

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

        var completedFrame: MediaDatagramCompletedFrame? {
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
                wasRepaired: repairDeadlineNs != nil
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

    func accept(_ packet: MediaDatagramFramePacket, now: UInt64) -> MediaDatagramRepairResult {
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
                packets: [packet.packetIndex: packet.payload],
                repairDeadlineNs: nil
            )
        }

        var result = MediaDatagramRepairResult.empty
        result.expiredFrames.append(contentsOf: expirePastDeadline(now: now))
        result.expiredFrames.append(contentsOf: enforceTrackedFrameLimit())
        let completed = drainCompletedFrames()
        result.repairedFrameCount += completed.filter(\.wasRepaired).count
        result.completedFrames.append(contentsOf: completed)
        result.resendRequests.append(contentsOf: requestMissingPackets(now: now))
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
            frames[frameId] = pending
            requests.append(MediaDatagramRepairRequest(frameId: frameId, packetIndexes: missing))
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
            return frame.incompleteFrame
        }
    }

    private func enforceTrackedFrameLimit() -> [IncompleteFrame] {
        var expired: [IncompleteFrame] = []
        while frames.count > trackedFrameLimit, let oldest = frames.keys.sorted().first {
            guard let frame = frames.removeValue(forKey: oldest) else { continue }
            deliveredFrameId = max(deliveredFrameId, oldest)
            if !frame.isComplete {
                expired.append(frame.incompleteFrame)
            }
        }
        return expired
    }

    private func drainCompletedFrames() -> [MediaDatagramCompletedFrame] {
        var completed: [MediaDatagramCompletedFrame] = []
        while let nextId = frames.keys.sorted().first,
              let frame = frames[nextId] {
            guard frame.isComplete, let completedFrame = frame.completedFrame else {
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
            repairedFrameCount: 0
        )
    }
}

struct MediaDatagramRepairRequest: Equatable {
    let frameId: UInt64
    let packetIndexes: [UInt16]
}

struct MediaDatagramCompletedFrame: Equatable {
    let frameId: UInt64
    let packetCount: UInt16
    let data: Data
    let wasRepaired: Bool
}

struct MediaDatagramRepairResult: Equatable {
    var resendRequests: [MediaDatagramRepairRequest]
    var completedFrames: [MediaDatagramCompletedFrame]
    var expiredFrames: [IncompleteFrame]
    var repairedFrameCount: Int

    static let empty = MediaDatagramRepairResult(
        resendRequests: [],
        completedFrames: [],
        expiredFrames: [],
        repairedFrameCount: 0
    )
}

struct IncompleteFrame: Equatable {
    let frameId: UInt64
    let received: Int
    let expected: Int
    let missingIndexes: [UInt16]
}
