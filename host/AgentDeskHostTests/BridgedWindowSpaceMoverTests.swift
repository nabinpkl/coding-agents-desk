import AgentDeskWire
import Foundation
import Testing

@testable import AgentDeskHost

struct BridgedWindowSpaceMoverTests {
    private final class Operation: BridgedWindowSpaceOperating, @unchecked Sendable {
        private let lock = NSLock()
        private var invocations: [(windowID: UInt32, spaceID: UInt64)] = []
        var error: Error?

        var calls: [(windowID: UInt32, spaceID: UInt64)] { lock.withLock { invocations } }

        func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
            lock.withLock { invocations.append((windowID, targetSpaceID)) }
            if let error { throw error }
        }
    }

    private struct StubMembership: WindowSpaceMembershipReading {
        let result: Result<[UInt64], Error>

        func spaceIDs(for windowID: UInt32) throws -> [UInt64] {
            try result.get()
        }
    }

    private enum StubError: Error {
        case failed
    }

    private func mover(
        operation: Operation,
        membership: Result<[UInt64], Error>
    ) -> BridgedWindowSpaceMover {
        BridgedWindowSpaceMover(
            operation: operation,
            membership: StubMembership(result: membership),
            verifyAttempts: 2,
            verifyInterval: 0
        )
    }

    @Test func operationReceivesTheRawWindowIDAndStableSpaceID() throws {
        let operation = Operation()

        try mover(operation: operation, membership: .success([7]))
            .move(windowID: 170_956, toSpaceID: 7)

        #expect(operation.calls.count == 1)
        #expect(operation.calls.first?.windowID == 170_956)
        #expect(operation.calls.first?.spaceID == 7)
    }

    @Test func missingPrivateOperationIsReportedAsAnUnavailableMover() throws {
        let operation = Operation()
        operation.error = WorkspaceWindowSpaceMoveError.missingSymbols

        #expect(throws: AgentWindowInputReason.windowMoverUnavailable) {
            try mover(operation: operation, membership: .success([7]))
                .move(windowID: 170_956, toSpaceID: 7)
        }
    }

    @Test func operationFailureIsReportedAsAFailedMove() throws {
        let operation = Operation()
        operation.error = StubError.failed

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(operation: operation, membership: .success([7]))
                .move(windowID: 170_956, toSpaceID: 7)
        }
    }

    @Test func aDispatchedOperationThatDidNotLandIsRejected() throws {
        let operation = Operation()

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(operation: operation, membership: .success([6]))
                .move(windowID: 170_956, toSpaceID: 7)
        }
    }

    @Test func membershipOnTheTargetAndAnotherSpaceIsRejected() throws {
        let operation = Operation()

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(operation: operation, membership: .success([6, 7]))
                .move(windowID: 170_956, toSpaceID: 7)
        }
    }

    @Test func membershipReadFailureIsReportedAsAFailedMove() throws {
        let operation = Operation()

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(operation: operation, membership: .failure(StubError.failed))
                .move(windowID: 170_956, toSpaceID: 7)
        }
    }

    @Test func currentMacExposesTheBridgedWindowMoveOperation() {
        #expect(SkyLightBridgedWindowSpaceOperation.isAvailable)
    }
}
