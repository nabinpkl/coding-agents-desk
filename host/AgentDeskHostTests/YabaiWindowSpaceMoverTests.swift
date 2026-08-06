import AgentDeskWire
import Foundation
import Testing

@testable import AgentDeskHost

struct YabaiWindowSpaceMoverTests {
    /// Real-shaped `yabai -m query --spaces` output: the stable SkyLight Space ids and the positional
    /// Desktop numbers are deliberately NOT in step, because on this machine they are not.
    private static let spacesJSON = """
        [{"id":3,"index":1,"display":1},
         {"id":4,"index":2,"display":1},
         {"id":6,"index":3,"display":1},
         {"id":7,"index":4,"display":1}]
        """

    private final class Runner: YabaiSyncCommandRunning, @unchecked Sendable {
        private let lock = NSLock()
        private var invocations: [[String]] = []
        var spacesOutput = YabaiWindowSpaceMoverTests.spacesJSON
        var error: Error?

        var commands: [[String]] { lock.withLock { invocations } }

        func runNow(arguments: [String]) throws -> Data {
            lock.withLock { invocations.append(arguments) }
            if let error { throw error }
            return Data(arguments.contains("--spaces") ? spacesOutput.utf8 : "".utf8)
        }
    }

    private struct StubMembership: WindowSpaceMembershipReading {
        let spaceIDs: [UInt64]
        func spaceIDs(for windowID: UInt32) throws -> [UInt64] { spaceIDs }
    }

    private func mover(
        runner: Runner,
        landsOn spaceIDs: [UInt64]
    ) -> YabaiWindowSpaceMover {
        YabaiWindowSpaceMover(
            commandRunner: runner,
            membership: StubMembership(spaceIDs: spaceIDs),
            verifyAttempts: 2,
            verifyInterval: 0
        )
    }

    @Test func theMoveCommandCarriesTheDesktopOrdinalResolvedFromTheStableSpaceID() throws {
        // yabai's window command takes a positional Desktop number, while everything upstream of here
        // speaks stable SkyLight Space ids. Sending the Space id straight through would move the window
        // to whatever Desktop happened to sit at that position.
        let runner = Runner()

        try mover(runner: runner, landsOn: [7]).move(windowID: 170_956, toSpaceID: 7)

        #expect(runner.commands == [
            ["-m", "query", "--spaces"],
            ["-m", "window", "170956", "--space", "4"],
        ])
    }

    @Test func aDesktopThatNoLongerExistsFailsBeforeAnyWindowIsTouched() throws {
        let runner = Runner()

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(runner: runner, landsOn: [7]).move(windowID: 170_956, toSpaceID: 99)
        }
        #expect(runner.commands == [["-m", "query", "--spaces"]])
    }

    @Test func aMissingYabaiIsItsOwnReasonRatherThanAFailedMove() throws {
        // The whole point of this type is that macOS offers no way to move another application's window
        // between Desktops without it, so "not installed" is a different sentence from "did not move".
        let runner = Runner()
        runner.error = YabaiCommandError.executableUnavailable("/nowhere/yabai")

        #expect(throws: AgentWindowInputReason.windowMoverUnavailable) {
            try mover(runner: runner, landsOn: [7]).move(windowID: 170_956, toSpaceID: 7)
        }
    }

    @Test func aCommandThatSucceededWithoutMovingAnythingIsCaughtByVerification() throws {
        // yabai exits zero whether or not WindowServer honoured the move -- a yabai without its
        // scripting addition does exactly that -- so the membership read is the only real confirmation.
        let runner = Runner()

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(runner: runner, landsOn: [6]).move(windowID: 170_956, toSpaceID: 7)
        }
        #expect(runner.commands.last == ["-m", "window", "170956", "--space", "4"])
    }

    @Test func aWindowOnTheTargetAndSomewhereElseIsNotAcceptedAsLanded() throws {
        // Exact match, not membership: a window that is also on another Desktop is not where the
        // composer needs it to be, and treating it as landed would write into a window that is not here.
        let runner = Runner()

        #expect(throws: AgentWindowInputReason.moveFailed) {
            try mover(runner: runner, landsOn: [6, 7]).move(windowID: 170_956, toSpaceID: 7)
        }
    }
}
