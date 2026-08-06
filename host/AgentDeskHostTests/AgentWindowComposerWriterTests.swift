import AgentDeskWire
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

struct AgentWindowComposerWriterTests {
    /// Records the order of every side effect, because the ordering is the contract under test.
    private final class Recorder: AgentWindowComposerAccessing, AgentWindowDesktopMoving {
        enum Step: Equatable {
            case latch(pid_t)
            case awaitComposer
            case read
            case write(String)
            case move(windowID: UInt32, spaceID: UInt64)
        }

        var steps: [Step] = []
        var frontmost: [pid_t?] = [100, 100]
        var latchError: AgentWindowInputReason?
        var awaitError: AgentWindowInputReason?
        var writeError: AgentWindowInputReason?
        var readBack: String?
        var moveFailures: Set<UInt64> = []
        var moveFailureReason: AgentWindowInputReason?

        func frontmostApplicationPID() -> pid_t? {
            frontmost.isEmpty ? nil : frontmost.removeFirst()
        }

        func latchManualAccessibility(pid: pid_t) throws {
            steps.append(.latch(pid))
            if let latchError { throw latchError }
        }

        func awaitComposer(for target: AgentWindowSessionTarget) throws {
            steps.append(.awaitComposer)
            if let awaitError { throw awaitError }
        }

        func readComposer(for target: AgentWindowSessionTarget) throws -> String {
            steps.append(.read)
            return readBack ?? ""
        }

        func writeComposer(_ text: String, for target: AgentWindowSessionTarget) throws -> String {
            steps.append(.write(text))
            if let writeError { throw writeError }
            return readBack ?? text
        }

        func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
            steps.append(.move(windowID: windowID, spaceID: targetSpaceID))
            if moveFailures.contains(targetSpaceID) {
                throw moveFailureReason ?? AgentWindowInputReason.moveFailed
            }
        }
    }

    private func target(homeSpaceID: UInt64, activeSpaceID: UInt64 = 1) -> AgentWindowSessionTarget {
        AgentWindowSessionTarget(
            sessionId: "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e",
            claudeMainPid: 400,
            windowID: 42,
            homeSpaceID: homeSpaceID,
            activeSpaceID: activeSpaceID,
            frame: CGRect(x: 0, y: 0, width: 1200, height: 800)
        )
    }

    @Test func aWindowOnAnotherDesktopIsBroughtHereAndPutBack() {
        let recorder = Recorder()
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.write("draft prompt", to: target(homeSpaceID: 4))

        #expect(result == .success("draft prompt"))
        // The wait sits between the move-in and the write, because Chromium builds the window's tree
        // only once it is on this Desktop: writing straight after the move finds no composer.
        #expect(recorder.steps == [
            .latch(400),
            .move(windowID: 42, spaceID: 1),
            .awaitComposer,
            .write("draft prompt"),
            .move(windowID: 42, spaceID: 4),
        ])
    }

    @Test func aWindowAlreadyHereIsNotMovedOrWaitedFor() {
        // Its tree is already built, so the materialize wait would be pure latency on the common path.
        let recorder = Recorder()
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        _ = writer.write("draft prompt", to: target(homeSpaceID: 1))

        #expect(recorder.steps == [.latch(400), .write("draft prompt")])
    }

    @Test func aComposerThatNeverAppearsStillReturnsTheWindow() {
        // The window is on the user's Desktop at this point. Whatever the tree did, it goes back.
        let recorder = Recorder()
        recorder.awaitError = .composerMissing
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.write("draft prompt", to: target(homeSpaceID: 4))

        #expect(result == .failure(.composerMissing))
        #expect(recorder.steps == [
            .latch(400),
            .move(windowID: 42, spaceID: 1),
            .awaitComposer,
            .move(windowID: 42, spaceID: 4),
        ])
    }

    @Test func aMoverWithItsOwnDiagnosisKeepsIt() {
        // "yabai is not installed" must not arrive as "the move failed": one is fixed by installing
        // something, the other invites a retry that cannot work.
        let recorder = Recorder()
        recorder.moveFailures = [1]
        recorder.moveFailureReason = .windowMoverUnavailable
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt", to: target(homeSpaceID: 4)) == .failure(.windowMoverUnavailable))
    }

    @Test func aFailedWriteStillReturnsTheWindowToItsDesktop() {
        // The user's workspace outranks the write. Leaving a Claude window stranded on the Desktop they
        // are looking at is a visible change they did not ask for, and it would outlive the error.
        let recorder = Recorder()
        recorder.writeError = .writeFailed
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.write("draft prompt", to: target(homeSpaceID: 4))

        #expect(result == .failure(.writeFailed))
        #expect(recorder.steps.last == .move(windowID: 42, spaceID: 4))
    }

    @Test func aStrandedWindowIsReportedInPreferenceToTheWriteResult() {
        // Both the write and the restore failed. The restore is what the human can see, so that is the
        // reason the panel shows.
        let recorder = Recorder()
        recorder.writeError = .writeFailed
        recorder.moveFailures = [4]
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt", to: target(homeSpaceID: 4)) == .failure(.moveFailed))
    }

    @Test func aWriteIsNotAttemptedWhenTheWindowCannotBeBroughtHere() {
        let recorder = Recorder()
        recorder.moveFailures = [1]
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.write("draft prompt", to: target(homeSpaceID: 4))

        #expect(result == .failure(.moveFailed))
        // No write, and no restore either: the window never left its Desktop.
        #expect(recorder.steps == [.latch(400), .move(windowID: 42, spaceID: 1)])
    }

    @Test func aDeniedLatchStopsBeforeAnythingMoves() {
        let recorder = Recorder()
        recorder.latchError = .accessibilityDenied
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt", to: target(homeSpaceID: 4)) == .failure(.accessibilityDenied))
        #expect(recorder.steps == [.latch(400)])
    }

    @Test func aComposerThatReadsBackDifferentlyIsReportedRatherThanBelieved() {
        let recorder = Recorder()
        recorder.readBack = "something else"
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt", to: target(homeSpaceID: 1)) == .failure(.verifyMismatch))
    }

    @Test func anActivationLeakIsReportedEvenWhenTheWriteItselfLanded() {
        // Nothing in this path activates an application, so a changed frontmost app means the
        // non-activating assumption broke. It cannot be undone, only surfaced.
        let recorder = Recorder()
        recorder.frontmost = [100, 400]
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt", to: target(homeSpaceID: 1)) == .failure(.focusStolen))
    }

    @Test func clearingTheComposerIsAWriteLikeAnyOther() {
        // An empty string is a real intent here: it wipes a draft the human wants gone. Only sending an
        // empty prompt would be meaningless, and this never sends.
        let recorder = Recorder()
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("", to: target(homeSpaceID: 1)) == .success(""))
        #expect(recorder.steps == [.latch(400), .write("")])
    }

    @Test func aReadIsServedOnlyWhenItCostsNoDesktopFlash() {
        let free = Recorder()
        free.readBack = "existing draft"
        let freeWriter = AgentWindowComposerWriter(access: free, placement: free)
        #expect(freeWriter.readIfFree(target(homeSpaceID: 1)) == .success("existing draft"))
        #expect(free.steps == [.latch(400), .read])

        // Off the active Desktop the window would have to be dragged onto the user's screen and back
        // just to prefill a field. The panel offers an explicit load instead.
        let costly = Recorder()
        costly.readBack = "existing draft"
        let costlyWriter = AgentWindowComposerWriter(access: costly, placement: costly)
        #expect(costlyWriter.readIfFree(target(homeSpaceID: 4)) == .success(nil))
        #expect(costly.steps.isEmpty)
    }
}
