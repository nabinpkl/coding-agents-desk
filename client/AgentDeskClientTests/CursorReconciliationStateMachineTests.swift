import CoreGraphics
import Testing

@testable import AgentDeskClient

struct CursorReconciliationStateMachineTests {
    private let bounds = CGRect(x: 0, y: 0, width: 200, height: 150)

    @Test func staleAppliedRevisionAdvancesProgressWithoutRewindingPrediction() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        let first = machine.record(.move(CGPoint(x: 10, y: 0)), sentAt: 0)!
        let second = machine.record(.move(CGPoint(x: 20, y: 0)), sentAt: 0.1)!

        let correction = machine.applyHostApplied(
            revision: first,
            position: CGPoint(x: 10, y: 0),
            now: 0.2
        )

        #expect(correction == nil)
        #expect(machine.pendingRevisions == [second])
        #expect(machine.confidence == .awaitingHost)
    }

    @Test func latestAppliedRevisionConfirmsAndReturnsAuthoritativePosition() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        _ = machine.record(.move(CGPoint(x: 10, y: 0)), sentAt: 0)
        let latest = machine.record(.move(CGPoint(x: 20, y: 0)), sentAt: 0.1)!

        let correction = machine.applyHostApplied(
            revision: latest,
            position: CGPoint(x: 29, y: 0),
            now: 0.2
        )

        #expect(correction == CGPoint(x: 29, y: 0))
        #expect(machine.pendingRevisions.isEmpty)
        #expect(machine.confidence == .confirmed)
    }

    @Test func oldestPendingDeadlineIsNotExtendedByContinuedMovement() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        _ = machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0)
        _ = machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0.9)

        machine.advance(now: 1.01)

        #expect(machine.confidence == .ghost)
        #expect(machine.ghostDeadline == 1)
    }

    @Test func sendFailureGhostsImmediatelyAndLatestAckRecovers() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        let revision = machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0)!

        machine.markSendFailed(revision: revision)
        #expect(machine.confidence == .ghost)

        let correction = machine.applyHostApplied(
            revision: revision,
            position: CGPoint(x: 1, y: 0),
            now: 0.1
        )
        #expect(correction == CGPoint(x: 1, y: 0))
        #expect(machine.confidence == .confirmed)
    }

    @Test func hostMovementRebasesAndReplaysNewerClientOperations() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        let first = machine.record(.move(CGPoint(x: 5, y: 0)), sentAt: 0)!
        let second = machine.record(.move(CGPoint(x: 0, y: 3)), sentAt: 0.1)!

        let reconciled = machine.applyHostMoved(
            position: CGPoint(x: 100, y: 100),
            afterRevision: first,
            displayBounds: bounds,
            now: 0.2
        )

        #expect(reconciled == CGPoint(x: 100, y: 103))
        #expect(machine.pendingRevisions == [second])
        #expect(machine.confidence == .awaitingHost)
    }

    @Test func hostMovementWithoutPendingInputIsImmediatelyAuthoritative() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)

        let reconciled = machine.applyHostMoved(
            position: CGPoint(x: 80, y: 70),
            afterRevision: nil,
            displayBounds: bounds,
            now: 2
        )

        #expect(reconciled == CGPoint(x: 80, y: 70))
        #expect(machine.confidence == .confirmed)
    }

    @Test func duplicateAndFutureAppliedRevisionsCannotChangeState() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        let revision = machine.record(.move(CGPoint(x: 2, y: 0)), sentAt: 0)!

        #expect(machine.applyHostApplied(
            revision: revision + 1,
            position: CGPoint(x: 99, y: 99),
            now: 0.1
        ) == nil)
        #expect(machine.pendingRevisions == [revision])

        _ = machine.applyHostApplied(
            revision: revision,
            position: CGPoint(x: 2, y: 0),
            now: 0.2
        )
        #expect(machine.applyHostApplied(
            revision: revision,
            position: CGPoint(x: 100, y: 100),
            now: 0.3
        ) == nil)
    }

    @Test func pendingWindowIsBoundedAndCapacityFailureGhosts() {
        var machine = CursorReconciliationStateMachine(
            confirmationTimeout: 1,
            pendingOperationLimit: 2
        )
        let first = machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0)!
        let second = machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0.1)!

        #expect(machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0.2) == nil)
        #expect(machine.pendingRevisions == [first, second])
        #expect(machine.confidence == .ghost)

        _ = machine.applyHostApplied(
            revision: second,
            position: CGPoint(x: 2, y: 0),
            now: 0.3
        )
        #expect(machine.confidence == .confirmed)
    }

    @Test func resetClearsPendingStateAndRestartsRevisionSequence() {
        var machine = CursorReconciliationStateMachine(confirmationTimeout: 1)
        _ = machine.record(.move(CGPoint(x: 1, y: 0)), sentAt: 0)!
        machine.advance(now: 2)

        machine.reset()

        #expect(machine.pendingRevisions.isEmpty)
        #expect(machine.confidence == .confirmed)
        let revision = machine.record(.move(CGPoint(x: 2, y: 0)), sentAt: 3)
        #expect(revision == 1)
    }
}
