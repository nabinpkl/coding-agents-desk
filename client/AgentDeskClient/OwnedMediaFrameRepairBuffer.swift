import Foundation

// ADR-0073: packet repair is opportunistic and never a presentation deadline.
// An incomplete frame may request one bounded resend while a newer frame is still
// assembling. Once any newer frame completes, older incomplete assemblies are
// skipped immediately and their late packets are rejected by deliveredFrameId.
final class MediaDatagramFrameRepairBuffer {
    private struct PendingFrame {
        let frameId: UInt64
        let packetCount: UInt16
        let isKeyframe: Bool
        var packets: [UInt16: Data]
        var resendRequested: Bool

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
                isKeyframe: isKeyframe,
                data: frame,
                wasRepaired: resendRequested
            )
        }
    }

    private let trackedFrameLimit: Int
    private let maxResendPackets: Int
    private var newestFrameId: UInt64 = 0
    private var deliveredFrameId: UInt64 = 0
    private var frames: [UInt64: PendingFrame] = [:]

    init(trackedFrameLimit: Int, maxResendPackets: Int) {
        self.trackedFrameLimit = max(1, trackedFrameLimit)
        self.maxResendPackets = max(1, maxResendPackets)
    }

    func accept(_ packet: MediaDatagramFramePacket) -> MediaDatagramRepairResult {
        guard packet.packetIndex < packet.packetCount,
              packet.frameId > deliveredFrameId else {
            return .empty
        }
        newestFrameId = max(newestFrameId, packet.frameId)
        if var pending = frames[packet.frameId] {
            guard pending.packetCount == packet.packetCount,
                  pending.isKeyframe == packet.isKeyframe else {
                return skip(frameId: packet.frameId)
            }
            pending.packets[packet.packetIndex] = packet.payload
            frames[packet.frameId] = pending
        } else {
            frames[packet.frameId] = PendingFrame(
                frameId: packet.frameId,
                packetCount: packet.packetCount,
                isKeyframe: packet.isKeyframe,
                packets: [packet.packetIndex: packet.payload],
                resendRequested: false
            )
        }

        var result = MediaDatagramRepairResult.empty
        result.skippedFrames.append(contentsOf: skipFramesOvertakenByCompletion())
        let completed = drainCompletedFrames()
        result.repairedFrameCount += completed.filter(\.wasRepaired).count
        result.completedFrames.append(contentsOf: completed)
        result.skippedFrames.append(contentsOf: enforceTrackedFrameLimit())
        result.resendRequests.append(contentsOf: requestMissingPackets())
        result.pendingFrameCount = frames.count
        return result
    }

    private func requestMissingPackets() -> [MediaDatagramRepairRequest] {
        var requests: [MediaDatagramRepairRequest] = []
        for frameId in frames.keys.sorted() {
            guard frameId < newestFrameId,
                  var pending = frames[frameId],
                  !pending.isComplete,
                  !pending.resendRequested
            else {
                continue
            }
            let missing = Array(pending.missingIndexes.prefix(maxResendPackets))
            guard !missing.isEmpty else { continue }
            pending.resendRequested = true
            frames[frameId] = pending
            requests.append(MediaDatagramRepairRequest(frameId: frameId, packetIndexes: missing))
        }
        return requests
    }

    private func skipFramesOvertakenByCompletion() -> [IncompleteFrame] {
        guard let newestCompletedId = frames.values
            .filter(\.isComplete)
            .map(\.frameId)
            .max()
        else {
            return []
        }
        let skippedIds = frames.keys.sorted().filter { frameId in
            guard frameId < newestCompletedId, let frame = frames[frameId] else {
                return false
            }
            return !frame.isComplete
        }
        return skippedIds.compactMap { frameId in
            guard let frame = frames.removeValue(forKey: frameId) else { return nil }
            deliveredFrameId = max(deliveredFrameId, frameId)
            return frame.incompleteFrame
        }
    }

    private func enforceTrackedFrameLimit() -> [IncompleteFrame] {
        var skipped: [IncompleteFrame] = []
        while frames.count > trackedFrameLimit, let oldest = frames.keys.sorted().first {
            guard let frame = frames.removeValue(forKey: oldest) else { continue }
            deliveredFrameId = max(deliveredFrameId, oldest)
            if !frame.isComplete {
                skipped.append(frame.incompleteFrame)
            }
        }
        return skipped
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

    private func skip(frameId: UInt64) -> MediaDatagramRepairResult {
        guard let frame = frames.removeValue(forKey: frameId) else {
            return .empty
        }
        deliveredFrameId = max(deliveredFrameId, frameId)
        return MediaDatagramRepairResult(
            resendRequests: [],
            completedFrames: [],
            skippedFrames: [frame.incompleteFrame],
            repairedFrameCount: 0,
            pendingFrameCount: frames.count
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
    let isKeyframe: Bool
    let data: Data
    let wasRepaired: Bool
}

struct MediaDatagramRepairResult: Equatable {
    var resendRequests: [MediaDatagramRepairRequest]
    var completedFrames: [MediaDatagramCompletedFrame]
    var skippedFrames: [IncompleteFrame]
    var repairedFrameCount: Int
    var pendingFrameCount: Int

    static let empty = MediaDatagramRepairResult(
        resendRequests: [],
        completedFrames: [],
        skippedFrames: [],
        repairedFrameCount: 0,
        pendingFrameCount: 0
    )
}

struct IncompleteFrame: Equatable {
    let frameId: UInt64
    let received: Int
    let expected: Int
    let missingIndexes: [UInt16]
}

struct MediaFrameRecoveryGate: Equatable {
    enum CompletedFrameDecision: Equatable {
        case render
        case renderRecoveryKeyframe
        case discardRecoveryDelta
    }

    private let keyframeRequestMinGapNs: UInt64
    private(set) var awaitingKeyframe = false
    private var lastKeyframeRequestNs: UInt64?

    init(keyframeRequestMinGapNs: UInt64) {
        self.keyframeRequestMinGapNs = keyframeRequestMinGapNs
    }

    mutating func noteGapSkip() {
        awaitingKeyframe = true
    }

    mutating func decideCompletedFrame(isKeyframe: Bool) -> CompletedFrameDecision {
        guard awaitingKeyframe else { return .render }
        guard isKeyframe else { return .discardRecoveryDelta }
        awaitingKeyframe = false
        lastKeyframeRequestNs = nil
        return .renderRecoveryKeyframe
    }

    mutating func takeKeyframeRequestIfNeeded(nowNs: UInt64) -> Bool {
        guard awaitingKeyframe else { return false }
        if let last = lastKeyframeRequestNs,
           nowNs >= last,
           nowNs - last < keyframeRequestMinGapNs {
            return false
        }
        lastKeyframeRequestNs = nowNs
        return true
    }
}
