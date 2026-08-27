import Foundation
import Testing

@testable import AgentDeskHost

struct CodexWindowLauncherTests {
    @Test func opensOneNewWindowAndLeavesItWhenItAlreadyLandedOnTheRequestedDesktop() throws {
        let application = RecordingCodexApplication(runningPID: 700)
        let mover = RecordingCodexWindowMover()
        let launcher = CodexWindowLauncher(
            application: application,
            audit: SequenceCodexWindowAudit([
                Self.snapshot(windows: [Self.window(id: 10, pid: 700, spaceID: 42)]),
                Self.snapshot(windows: [
                    Self.window(id: 10, pid: 700, spaceID: 42),
                    Self.window(id: 20, pid: 700, spaceID: 42),
                ]),
            ]),
            mover: mover,
            pollAttempts: 1,
            pollInterval: 0
        )

        let windowID = try launcher.openNow(on: Self.targetDesktop)

        #expect(windowID == 20)
        #expect(application.requestedPIDs == [700])
        #expect(application.launchCount == 0)
        #expect(mover.moves.isEmpty)
    }

    @Test func movesTheExactNewWindowWhenCodexCreatesItOnAnotherDesktop() throws {
        let application = RecordingCodexApplication(runningPID: 700)
        let mover = RecordingCodexWindowMover()
        let launcher = CodexWindowLauncher(
            application: application,
            audit: SequenceCodexWindowAudit([
                Self.snapshot(windows: [Self.window(id: 10, pid: 700, spaceID: 42)]),
                Self.snapshot(windows: [
                    Self.window(id: 10, pid: 700, spaceID: 42),
                    Self.window(id: 20, pid: 700, spaceID: 10),
                ]),
            ]),
            mover: mover,
            pollAttempts: 1,
            pollInterval: 0
        )

        let windowID = try launcher.openNow(on: Self.targetDesktop)

        #expect(windowID == 20)
        #expect(mover.moves == [.init(windowID: 20, spaceID: 42)])
    }

    @Test func launchingCodexUsesItsInitialWindowInsteadOfRequestingASecondOne() throws {
        let application = RecordingCodexApplication(runningPID: nil, launchedPID: 700)
        let launcher = CodexWindowLauncher(
            application: application,
            audit: SequenceCodexWindowAudit([
                Self.snapshot(windows: []),
                Self.snapshot(windows: [Self.window(id: 20, pid: 700, spaceID: 42)]),
            ]),
            mover: RecordingCodexWindowMover(),
            pollAttempts: 1,
            pollInterval: 0
        )

        #expect(try launcher.openNow(on: Self.targetDesktop) == 20)
        #expect(application.launchCount == 1)
        #expect(application.requestedPIDs.isEmpty)
    }

    @Test func moreThanOneNewWindowRefusesRatherThanGuessing() throws {
        let application = RecordingCodexApplication(runningPID: 700)
        let mover = RecordingCodexWindowMover()
        let launcher = CodexWindowLauncher(
            application: application,
            audit: SequenceCodexWindowAudit([
                Self.snapshot(windows: []),
                Self.snapshot(windows: [
                    Self.window(id: 20, pid: 700, spaceID: 42),
                    Self.window(id: 21, pid: 700, spaceID: 42),
                ]),
            ]),
            mover: mover,
            pollAttempts: 1,
            pollInterval: 0
        )

        #expect(throws: CodexWindowLaunchError.ambiguousNewWindows([20, 21])) {
            try launcher.openNow(on: Self.targetDesktop)
        }
        #expect(mover.moves.isEmpty)
    }

    @Test func anUnavailableTargetDesktopFailsBeforeCodexIsTouched() throws {
        let application = RecordingCodexApplication(runningPID: 700)
        let launcher = CodexWindowLauncher(
            application: application,
            audit: SequenceCodexWindowAudit([
                WorkspaceDesktopSnapshot(activeSpaceID: 10, desktops: [], windows: [], diagnostic: nil),
            ]),
            mover: RecordingCodexWindowMover(),
            pollAttempts: 1,
            pollInterval: 0
        )

        #expect(throws: CodexWindowLaunchError.targetDesktopUnavailable(spaceID: 42)) {
            try launcher.openNow(on: Self.targetDesktop)
        }
        #expect(application.requestedPIDs.isEmpty)
        #expect(application.launchCount == 0)
    }

    @Test func noNewWindowTimesOutWithoutMovingAnExistingWindow() throws {
        let application = RecordingCodexApplication(runningPID: 700)
        let mover = RecordingCodexWindowMover()
        let unchanged = Self.snapshot(windows: [Self.window(id: 10, pid: 700, spaceID: 42)])
        let launcher = CodexWindowLauncher(
            application: application,
            audit: SequenceCodexWindowAudit([unchanged, unchanged]),
            mover: mover,
            pollAttempts: 1,
            pollInterval: 0
        )

        #expect(throws: CodexWindowLaunchError.windowAppearanceTimedOut) {
            try launcher.openNow(on: Self.targetDesktop)
        }
        #expect(mover.moves.isEmpty)
    }

    private static let targetDesktop = WorkspaceDesktopAssignment(
        spaceID: 42,
        displayID: "D1",
        ordinal: 1
    )

    private static func snapshot(windows: [WorkspaceDesktopWindow]) -> WorkspaceDesktopSnapshot {
        WorkspaceDesktopSnapshot(
            activeSpaceID: 42,
            desktops: [
                WorkspaceDesktop(
                    id: 42,
                    displayID: "D1",
                    ordinal: 1,
                    missionControlOrdinal: 1,
                    isActive: true
                ),
            ],
            windows: windows,
            diagnostic: nil
        )
    }

    private static func window(id: UInt32, pid: pid_t, spaceID: UInt64) -> WorkspaceDesktopWindow {
        WorkspaceDesktopWindow(
            windowID: id,
            ownerPID: pid,
            ownerName: "ChatGPT",
            title: "ChatGPT",
            spaceIDs: [spaceID],
            layer: 0,
            bounds: CGRect(x: 0, y: 0, width: 1_000, height: 700),
            expectation: .otherApp
        )
    }
}

private final class RecordingCodexApplication: CodexDesktopApplicationOpening, @unchecked Sendable {
    private let runningPID: pid_t?
    private let launchedPID: pid_t
    private(set) var requestedPIDs: [pid_t] = []
    private(set) var launchCount = 0

    init(runningPID: pid_t?, launchedPID: pid_t = 700) {
        self.runningPID = runningPID
        self.launchedPID = launchedPID
    }

    func runningMainPID() throws -> pid_t? { runningPID }

    func launch() throws -> pid_t {
        launchCount += 1
        return launchedPID
    }

    func requestNewWindow(mainPID: pid_t) throws {
        requestedPIDs.append(mainPID)
    }
}

private final class SequenceCodexWindowAudit: WorkspaceDesktopAuditing, @unchecked Sendable {
    private let lock = NSLock()
    private let snapshots: [WorkspaceDesktopSnapshot]
    private var index = 0

    init(_ snapshots: [WorkspaceDesktopSnapshot]) {
        self.snapshots = snapshots
    }

    func snapshot() -> WorkspaceDesktopSnapshot {
        lock.withLock {
            let value = snapshots[min(index, snapshots.count - 1)]
            index += 1
            return value
        }
    }
}

private final class RecordingCodexWindowMover: AgentWindowDesktopMoving, @unchecked Sendable {
    struct Move: Equatable {
        let windowID: UInt32
        let spaceID: UInt64
    }

    private(set) var moves: [Move] = []

    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
        moves.append(.init(windowID: windowID, spaceID: targetSpaceID))
    }
}
