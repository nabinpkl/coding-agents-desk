// Host-side owned-graphics send state (pacing, backpressure, ack waiting, recovery).
// Formerly part of SharedTypes.swift; the shared wire shapes moved to AgentDeskWire
// (ADR-0050), leaving only these host-only behavior types.
import CryptoKit
import Foundation
import AgentDeskWire


// ADR-0003 and ADR-0030 session-establishment wire shapes. Sent on the control
// stream inside the authenticated session QUIC connection.


// Owned-media video wire types. Scrolling motion rides hardware HEVC over the
// session QUIC datagram lane. These are the carrier-agnostic frame shapes; the
// host encoder fills them and the client video layer decodes them.
// Length-prefixed NAL payload, parameter sets carried on keyframes only.






enum HybridGraphicsRecoveryState: String, Equatable, Sendable {
    case idle
    case resetting
    case reconnecting
    case failedCoolingDown
}

enum OwnedGraphicsResetSendError: Error, Equatable {
    case ackTimeout(OwnedSurfaceUpdateId)
    case staleChannel(OwnedSurfaceUpdateId)
}

final class OwnedGraphicsAckWaiter: @unchecked Sendable {
    private struct Waiter {
        let updateId: OwnedSurfaceUpdateId
        let continuation: CheckedContinuation<Bool, Never>
    }

    private let lock = NSLock()
    private var latestAck: OwnedSurfaceUpdateId?
    private var waiters: [UUID: Waiter] = [:]

    func wait(for updateId: OwnedSurfaceUpdateId, timeoutMs: Int) async -> Bool {
        let id = UUID()
        let shouldScheduleTimeout = lock.withLock {
            if let latestAck, latestAck >= updateId {
                return false
            }
            return true
        }
        if !shouldScheduleTimeout {
            return true
        }
        return await withCheckedContinuation { continuation in
            let shouldResumeNow = lock.withLock {
                if let latestAck, latestAck >= updateId {
                    return true
                }
                waiters[id] = Waiter(updateId: updateId, continuation: continuation)
                return false
            }
            if shouldResumeNow {
                continuation.resume(returning: true)
                return
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(1, timeoutMs)) * 1_000_000)
                self?.finishWaiter(id: id, result: false)
            }
        }
    }

    func noteAck(_ ack: OwnedGraphicsFrameAck) {
        let completed = lock.withLock {
            if latestAck.map({ ack.updateId.isStrictlyNewer(than: $0) }) ?? true {
                latestAck = ack.updateId
            }
            let covered = waiters.filter { _, waiter in
                ack.updateId >= waiter.updateId
            }
            for id in covered.keys {
                waiters.removeValue(forKey: id)
            }
            return Array(covered.values)
        }
        for waiter in completed {
            waiter.continuation.resume(returning: true)
        }
    }

    func reset() {
        let pending = lock.withLock {
            latestAck = nil
            let pending = Array(waiters.values)
            waiters.removeAll()
            return pending
        }
        for waiter in pending {
            waiter.continuation.resume(returning: false)
        }
    }

    private func finishWaiter(id: UUID, result: Bool) {
        let waiter = lock.withLock {
            waiters.removeValue(forKey: id)
        }
        waiter?.continuation.resume(returning: result)
    }
}

// ADR-0073: owned-media accounting is bounded without stalling fresh video.
// When either limit binds, the producer explicitly abandons the oldest frame
// until the latest capture can be admitted. ACKs remain cumulative accounting
// watermarks, but an ACK for an abandoned frame cannot retire a newer entry.
struct GraphicsBackpressure {
    struct InFlightFrame: Equatable {
        let id: UInt64
        let bytes: Int
        let sentAtUptimeNs: UInt64
    }

    let maxUnacked: Int
    // A2: in-flight byte ceiling. Defaults to .max so a caller that passes no byte
    // budget gets the pure frame-count behavior (and every existing count-only test
    // keeps its semantics).
    let maxUnackedBytes: Int
    // FIFO of in-flight frames in send order, carrying each frame's wire size. A
    // forward ack pops the oldest (acks are ~1:1 and monotonic, see noteAck), which
    // keeps the in-flight COUNT and in-flight BYTES exactly consistent without
    // relying on a frameId-keyed lookup that the reconnect-climbing frameId would
    // corrupt (B2).
    private var inFlightFrames: [InFlightFrame] = []
    private var inFlightBytes = 0
    private var lastAckedFrameId: UInt64 = 0

    init(maxUnacked: Int, maxUnackedBytes: Int = .max) {
        self.maxUnacked = max(maxUnacked, 1)
        self.maxUnackedBytes = max(maxUnackedBytes, 1)
    }

    var inFlight: Int { inFlightFrames.count }
    var bytesInFlight: Int { inFlightBytes }
    var oldestSentUptimeNs: UInt64? { inFlightFrames.first?.sentAtUptimeNs }

    // Admit when nothing is in flight (never block the first frame, so a single
    // oversized frame is never permanently stalled), else gate on BOTH the frame
    // count and the in-flight byte ceiling. The byte ceiling is the lever that keeps
    // the reliable send buffer shallow during fast scroll, where one frame can be
    // 100KB+; the count guard still bounds a flood of tiny frames.
    func canProduce() -> Bool {
        if inFlightFrames.isEmpty { return true }
        return inFlightFrames.count < maxUnacked && inFlightBytes < maxUnackedBytes
    }

    mutating func noteSent(
        frameId: UInt64,
        bytes: Int = 0,
        sentAtUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) {
        let b = max(0, bytes)
        inFlightFrames.append(
            InFlightFrame(id: frameId, bytes: b, sentAtUptimeNs: sentAtUptimeNs)
        )
        inFlightBytes += b
    }

    // What an ACK retired.
    //
    // ADR-0098: the byte count is the one measurement in this whole path that describes the
    // LINK rather than the host's intentions -- bytes the client confirmed it holds. It was
    // being computed here and discarded on the next line.
    struct AckRetirement: Equatable {
        // Set only when the ACKed frame itself was still tracked. See `noteAck`.
        let ackedSentAtUptimeNs: UInt64?
        let bytes: Int
        let frames: Int
    }

    // ACKs carry the highest applied frameId. Retire every tracked entry through
    // that watermark. Carry the timestamp only when the ACKed frame itself was
    // still tracked, so a late ACK for an abandoned frame cannot be misreported as
    // the age of a newer entry -- the retired bytes are reported either way, because
    // those frames did arrive however their timestamps are attributed.
    //
    // nil means the ACK did not advance the watermark and retired nothing.
    @discardableResult
    mutating func noteAck(frameId: UInt64) -> AckRetirement? {
        guard frameId > lastAckedFrameId else { return nil }
        lastAckedFrameId = frameId
        var ackedSentAtUptimeNs: UInt64?
        var retiredBytes = 0
        var retiredFrames = 0
        while let first = inFlightFrames.first, first.id <= frameId {
            let done = inFlightFrames.removeFirst()
            inFlightBytes = max(0, inFlightBytes - done.bytes)
            retiredBytes += done.bytes
            retiredFrames += 1
            if done.id == frameId {
                ackedSentAtUptimeNs = done.sentAtUptimeNs
            }
        }
        return AckRetirement(
            ackedSentAtUptimeNs: ackedSentAtUptimeNs,
            bytes: retiredBytes,
            frames: retiredFrames
        )
    }

    @discardableResult
    mutating func abandonOldest() -> InFlightFrame? {
        guard !inFlightFrames.isEmpty else { return nil }
        let abandoned = inFlightFrames.removeFirst()
        inFlightBytes = max(0, inFlightBytes - abandoned.bytes)
        return abandoned
    }

    mutating func abandonUntilCanProduce() -> [InFlightFrame] {
        var abandoned: [InFlightFrame] = []
        while !canProduce(), let frame = abandonOldest() {
            abandoned.append(frame)
        }
        return abandoned
    }

    // A new connection or a surface reset abandons every prior in-flight frame:
    // it will never be acked. Drop the list to empty so the cap starts clean.
    // The frameId watermark is intentionally left alone (it never resets) so the
    // monotonic ack guard above stays valid across the reconnect.
    mutating func reset() {
        inFlightFrames.removeAll()
        inFlightBytes = 0
    }
}

// The token bucket that used to live here moved to `LinkSendPacer` (ADR-0098). It was written
// for the reliable graphics channel ADR-0026 retired, sat here with tests and no caller, and now
// governs the datagram video path that replaced that channel.
