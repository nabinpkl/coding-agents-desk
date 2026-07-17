import Testing

@testable import AgentDeskHost

struct DockDesktopSwapStateMachineTests {
    private let primary = DockDesktopSwapSelection(
        spaceID: 100,
        desktopLabel: "Desktop 2",
        monitorBadgeLabel: "P"
    )
    private let secondary = DockDesktopSwapSelection(
        spaceID: 200,
        desktopLabel: "Desktop 8",
        monitorBadgeLabel: "S"
    )

    @Test mutating func twoSelectionsProduceOneSwapEffectWithoutUsingDesktopOrdinals() {
        var machine = DockDesktopSwapStateMachine()

        #expect(machine.send(.toggle) == nil)
        #expect(machine.state == .choosingSource)
        #expect(machine.send(.select(primary)) == nil)
        #expect(machine.state == .choosingDestination(source: primary))
        #expect(machine.send(.select(secondary)) == .swap(sourceSpaceID: 100, destinationSpaceID: 200))
        #expect(machine.state == .swapping(source: primary, destination: secondary))
        #expect(machine.state.holdsDock)
    }

    @Test mutating func selectingSourceAgainClearsItAndCancelReturnsIdle() {
        var machine = DockDesktopSwapStateMachine()
        _ = machine.send(.toggle)
        _ = machine.send(.select(primary))

        #expect(machine.send(.select(primary)) == nil)
        #expect(machine.state == .choosingSource)
        #expect(machine.send(.cancel) == nil)
        #expect(machine.state == .idle)
        #expect(!machine.state.holdsDock)
    }

    @Test mutating func successOffersUndoAndUndoUsesOriginalReceipt() {
        let receipt = DockDesktopSwapReceipt(
            sourceSpaceID: 100,
            destinationSpaceID: 200,
            sourceWindowIDs: [10],
            destinationWindowIDs: [20]
        )
        var machine = DockDesktopSwapStateMachine()
        _ = machine.send(.toggle)
        _ = machine.send(.select(primary))
        _ = machine.send(.select(secondary))

        #expect(machine.send(.swapSucceeded(receipt)) == nil)
        #expect(machine.state == .undoAvailable(.init(source: primary, destination: secondary, receipt: receipt)))
        #expect(machine.state.holdsDock)
        #expect(machine.send(.undo) == .undo(receipt))
        #expect(machine.state == .undoing(.init(source: primary, destination: secondary, receipt: receipt)))
        #expect(machine.send(.undoSucceeded) == nil)
        #expect(machine.state == .idle)
    }

    @Test mutating func expiryFailureAndBusyInputHaveExplicitTransitions() {
        let receipt = DockDesktopSwapReceipt(
            sourceSpaceID: 100,
            destinationSpaceID: 200,
            sourceWindowIDs: [],
            destinationWindowIDs: []
        )
        var machine = DockDesktopSwapStateMachine()
        _ = machine.send(.toggle)
        _ = machine.send(.select(primary))
        _ = machine.send(.select(secondary))

        #expect(machine.send(.toggle) == nil)
        #expect(machine.state == .swapping(source: primary, destination: secondary))
        _ = machine.send(.swapSucceeded(receipt))
        #expect(machine.send(.undoExpired) == nil)
        #expect(machine.state == .idle)

        _ = machine.send(.toggle)
        _ = machine.send(.operationFailed("yabai timed out"))
        #expect(machine.state == .failed("yabai timed out"))
        #expect(machine.state.holdsDock)
        #expect(machine.send(.cancel) == nil)
        #expect(machine.state == .idle)
    }

    @Test func presentationUsesTextAndNumberedMarkersInAdditionToColor() {
        #expect(DockDesktopSwapState.choosingSource.instruction == "Choose desktop 1")
        #expect(
            DockDesktopSwapState.choosingDestination(source: primary).instruction
                == "1 P · Desktop 2 selected. Choose desktop 2"
        )
        #expect(DockDesktopSwapState.choosingDestination(source: primary).marker(for: 100) == "1")
        #expect(DockDesktopSwapState.choosingDestination(source: primary).marker(for: 200) == "2")
        #expect(DockDesktopSwapState.choosingSource.shouldCancelForPrimaryClick(insideDock: false))
        #expect(!DockDesktopSwapState.choosingSource.shouldCancelForPrimaryClick(insideDock: true))
        #expect(
            !DockDesktopSwapState.swapping(source: primary, destination: secondary)
                .shouldCancelForPrimaryClick(insideDock: false)
        )
    }
}
