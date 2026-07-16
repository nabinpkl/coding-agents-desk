import CoreGraphics
import Foundation

// ADR-0058. Tracks cursor-input causality independently from UIKit and the
// transport. PairingViewController remains the owner of the displayed cursor
// point; this reducer owns only pending operations, applied progress, and the
// confidence of that prediction.
struct CursorReconciliationStateMachine: Sendable {
    static let defaultPendingOperationLimit = 4_096

    enum Confidence: Equatable, Sendable {
        case confirmed
        case awaitingHost
        case ghost
    }

    enum Operation: Equatable, Sendable {
        case set(CGPoint)
        case move(CGPoint)
    }

    private struct PendingOperation: Equatable, Sendable {
        let revision: UInt64
        let operation: Operation
        let sentAt: TimeInterval
    }

    private let confirmationTimeout: TimeInterval
    private let pendingOperationLimit: Int
    private var nextRevision: UInt64 = 1
    private var lastAppliedRevision: UInt64 = 0
    private var pending: [PendingOperation] = []

    private(set) var confidence: Confidence = .confirmed

    var pendingRevisions: [UInt64] {
        pending.map(\.revision)
    }

    var ghostDeadline: TimeInterval? {
        pending.first.map { $0.sentAt + confirmationTimeout }
    }

    init(
        confirmationTimeout: TimeInterval,
        pendingOperationLimit: Int = Self.defaultPendingOperationLimit
    ) {
        precondition(confirmationTimeout > 0, "cursor confirmation timeout must be positive")
        precondition(pendingOperationLimit > 0, "pending cursor operation limit must be positive")
        self.confirmationTimeout = confirmationTimeout
        self.pendingOperationLimit = pendingOperationLimit
    }

    // Returning nil is a deliberate backpressure failure. The caller must not
    // send an untracked cursor input; the grey ghost remains visible until the
    // host catches up to the bounded pending window or the session resets.
    mutating func record(_ operation: Operation, sentAt: TimeInterval) -> UInt64? {
        guard pending.count < pendingOperationLimit else {
            confidence = .ghost
            return nil
        }
        precondition(nextRevision < UInt64.max, "cursor revision exhausted")
        let revision = nextRevision
        nextRevision += 1
        pending.append(PendingOperation(
            revision: revision,
            operation: operation,
            sentAt: sentAt
        ))
        if confidence == .confirmed {
            confidence = .awaitingHost
        }
        return revision
    }

    // Returns an authoritative correction only when the host has caught up to
    // every client prediction. Older acknowledgements remove applied work but
    // never pull the visible cursor back to their older position.
    mutating func applyHostApplied(
        revision: UInt64,
        position: CGPoint,
        now: TimeInterval
    ) -> CGPoint? {
        guard revision > lastAppliedRevision,
              revision < nextRevision else {
            return nil
        }
        lastAppliedRevision = revision
        pending.removeAll { $0.revision <= revision }
        updateConfidence(now: now, recoverOnlyWhenCaughtUp: true)
        return pending.isEmpty ? position : nil
    }

    // Host-local movement is a new authoritative base. Inputs that the host had
    // not yet applied at observation time are replayed on top, which preserves
    // newer iPhone intent without treating an old remote acknowledgement as a
    // host-initiated correction.
    mutating func applyHostMoved(
        position: CGPoint,
        afterRevision: UInt64?,
        displayBounds: CGRect,
        now: TimeInterval
    ) -> CGPoint? {
        if let afterRevision {
            guard afterRevision < nextRevision else { return nil }
            if afterRevision > lastAppliedRevision {
                lastAppliedRevision = afterRevision
                pending.removeAll { $0.revision <= afterRevision }
            }
        }

        let replayed = pending.reduce(position) { point, pending in
            Self.apply(pending.operation, to: point, displayBounds: displayBounds)
        }
        updateConfidence(now: now, recoverOnlyWhenCaughtUp: true)
        return replayed
    }

    mutating func markSendFailed(revision: UInt64) {
        guard pending.contains(where: { $0.revision == revision }) else { return }
        confidence = .ghost
    }

    mutating func advance(now: TimeInterval) {
        updateConfidence(now: now, recoverOnlyWhenCaughtUp: true)
    }

    mutating func reset() {
        nextRevision = 1
        lastAppliedRevision = 0
        pending.removeAll(keepingCapacity: false)
        confidence = .confirmed
    }

    private mutating func updateConfidence(
        now: TimeInterval,
        recoverOnlyWhenCaughtUp: Bool
    ) {
        guard let deadline = ghostDeadline else {
            confidence = .confirmed
            return
        }
        if confidence == .ghost && recoverOnlyWhenCaughtUp {
            return
        }
        confidence = now >= deadline ? .ghost : .awaitingHost
    }

    private static func apply(
        _ operation: Operation,
        to point: CGPoint,
        displayBounds: CGRect
    ) -> CGPoint {
        switch operation {
        case .set(let target):
            return EdgeFollow.advanceCursor(
                from: target,
                delta: .zero,
                displayBounds: displayBounds
            )
        case .move(let delta):
            return EdgeFollow.advanceCursor(
                from: point,
                delta: delta,
                displayBounds: displayBounds
            )
        }
    }
}
