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
        let isLtrResync: Bool
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
                isLtrResync: isLtrResync,
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
                  pending.isKeyframe == packet.isKeyframe,
                  pending.isLtrResync == packet.isLtrResync else {
                return skip(frameId: packet.frameId)
            }
            pending.packets[packet.packetIndex] = packet.payload
            frames[packet.frameId] = pending
        } else {
            frames[packet.frameId] = PendingFrame(
                frameId: packet.frameId,
                packetCount: packet.packetCount,
                isKeyframe: packet.isKeyframe,
                isLtrResync: packet.isLtrResync,
                packets: [packet.packetIndex: packet.payload],
                resendRequested: false
            )
        }

        var result = MediaDatagramRepairResult.empty
        result.skippedFrames.append(contentsOf: skipFramesOvertakenByCompletion())
        let drained = drainCompletedFrames()
        result.repairedFrameCount += drained.completed.filter(\.wasRepaired).count
        result.completedFrames.append(contentsOf: drained.completed)
        result.skippedFrames.append(contentsOf: drained.whollyLost)
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

    /// Frame ids the current drain jumped over without ever seeing a packet.
    ///
    /// The skip machinery above only knows about frames it holds PARTIAL data for; a frame
    /// that loses every packet leaves no pending entry, so the stream silently jumped from
    /// 427 to 429 and the recovery gate never armed. Measured end to end: the delta after the
    /// hole references the frame the decoder never saw, `AVSampleBufferDisplayLayer` returns
    /// -11821 "Cannot Decode" on intact data, and the response cost a full IDR per occurrence
    /// -- recurring on a ~30s radio-layer cadence on LTE. Wire frame ids are contiguous by
    /// construction (the host's send-side abandons only drop resend bookkeeping for frames
    /// already sent), so a delivered-id gap IS loss, and it must arm the same recovery the
    /// partial-frame skip arms -- which the resync contract now settles for a few hundred
    /// bytes instead of the IDR.
    private func whollyLostFrames(before nextId: UInt64) -> [IncompleteFrame] {
        // deliveredFrameId == 0 is a transport that has delivered nothing yet: a resume or a
        // mid-stream join legitimately starts at an arbitrary id, and there is no chain to
        // protect before the first delivered frame.
        guard deliveredFrameId > 0, nextId > deliveredFrameId + 1 else { return [] }
        // Cap the enumeration: after a long stall the hole can be hundreds of ids, and the
        // point is arming the gate, not itemizing every casualty.
        let lost = (deliveredFrameId + 1)..<nextId
        return lost.prefix(8).map {
            IncompleteFrame(frameId: $0, received: 0, expected: 0, missingIndexes: [])
        }
    }

    private func drainCompletedFrames() -> (
        completed: [MediaDatagramCompletedFrame], whollyLost: [IncompleteFrame]
    ) {
        var completed: [MediaDatagramCompletedFrame] = []
        var whollyLost: [IncompleteFrame] = []
        while let nextId = frames.keys.sorted().first,
              let frame = frames[nextId] {
            guard frame.isComplete, let completedFrame = frame.completedFrame else {
                break
            }
            whollyLost.append(contentsOf: whollyLostFrames(before: nextId))
            frames.removeValue(forKey: nextId)
            deliveredFrameId = max(deliveredFrameId, nextId)
            completed.append(completedFrame)
        }
        return (completed, whollyLost)
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
    let isLtrResync: Bool
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

/// Decides what to do with completed frames after a gap skip broke the delta chain.
///
/// The original contract -- discard everything until a keyframe -- predates ADR-0090, which
/// made an LTR-refresh delta a valid resync. The two contracts ran unreconciled until an LTE
/// session measured the result: the gate requested "a keyframe" every 300ms, the host answered
/// each request with the cheap LTR delta it is supposed to prefer, and the gate discarded all
/// 763 of them while the picture stayed frozen. Neither side was violating its own rules.
///
/// So the gate now accepts either sync point: a keyframe, or a delta the host has marked as
/// the `ForceLTRRefresh` answer (`isLtrResync`, carried on the packet so this decision --
/// which runs before envelope decode -- can see it). The escalation path is the backstop for
/// references that are genuinely unusable: after `escalationDiscardLimit` discarded frames the
/// next request declares `clientHasNoReferences`, converting an unbounded loop into one IDR.
struct MediaFrameRecoveryGate: Equatable {
    enum CompletedFrameDecision: Equatable {
        case render
        case renderRecoveryKeyframe
        /// A marked LTR-resync delta resolved the gate. Distinct from the keyframe case so
        /// diagnostics can say WHICH path recovered -- the cheap one is the design working.
        case renderRecoveryResync
        case discardRecoveryDelta
    }

    struct KeyframeRequest: Equatable {
        /// True once the gate has been armed longer than the escalation window with nothing
        /// resolving it: the cheap answers are not landing, so the client's references are
        /// presumed unusable and the request must force a true keyframe.
        ///
        /// Time, deliberately not a discard count. The first version escalated after N
        /// discarded frames, which made escalation a function of MOTION RATE: at 14fps a
        /// 6-frame limit fired in ~400ms, far faster than any resync answer could cross the
        /// congested link it was queued behind. Measured in one 4-minute LTE session: 160
        /// gap-recovery requests, 116 escalations, and 164KB IDRs spending 2.7s in flight --
        /// the escalation manufacturing the exact jam it existed to break.
        let declareNoReferences: Bool
    }

    private let keyframeRequestMinGapNs: UInt64
    private let escalationNs: UInt64
    private(set) var awaitingKeyframe = false
    private var lastKeyframeRequestNs: UInt64?
    private(set) var discardedSinceArmed = 0
    private var armedAtNs: UInt64?

    init(keyframeRequestMinGapNs: UInt64, escalationNs: UInt64) {
        self.keyframeRequestMinGapNs = keyframeRequestMinGapNs
        self.escalationNs = max(1, escalationNs)
    }

    /// Arms the gate. Returns true when this call armed it (it was not already armed), so the
    /// caller can record the transition without tracking previous state itself.
    @discardableResult
    mutating func noteGapSkip(nowNs: UInt64) -> Bool {
        let armed = !awaitingKeyframe
        awaitingKeyframe = true
        if armed {
            armedAtNs = nowNs
            discardedSinceArmed = 0
        }
        return armed
    }

    /// The gate's answer for one completed frame, plus how long the gate had been armed when a
    /// resolving frame closed it (nil for non-resolving decisions).
    mutating func decideCompletedFrame(
        isKeyframe: Bool,
        isLtrResync: Bool,
        nowNs: UInt64
    ) -> (decision: CompletedFrameDecision, armedNs: UInt64?) {
        guard awaitingKeyframe else { return (.render, nil) }
        guard isKeyframe || isLtrResync else {
            discardedSinceArmed += 1
            return (.discardRecoveryDelta, nil)
        }
        let armedNs = armedAtNs.map { nowNs >= $0 ? nowNs - $0 : 0 }
        awaitingKeyframe = false
        lastKeyframeRequestNs = nil
        armedAtNs = nil
        discardedSinceArmed = 0
        return (isKeyframe ? .renderRecoveryKeyframe : .renderRecoveryResync, armedNs)
    }

    mutating func takeKeyframeRequestIfNeeded(nowNs: UInt64) -> KeyframeRequest? {
        guard awaitingKeyframe else { return nil }
        if let last = lastKeyframeRequestNs,
           nowNs >= last,
           nowNs - last < keyframeRequestMinGapNs {
            return nil
        }
        lastKeyframeRequestNs = nowNs
        let armedNs = armedAtNs.map { nowNs >= $0 ? nowNs - $0 : 0 } ?? 0
        return KeyframeRequest(declareNoReferences: armedNs >= escalationNs)
    }
}
