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
            case submit
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

        func submitComposer(for target: AgentWindowSessionTarget) throws -> String {
            steps.append(.submit)
            if let writeError { throw writeError }
            return readBack ?? ""
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

    @Test func aDraftEndingInReturnReadsBackCollapsedAndStillPasses() {
        // The web composer ends drafts with Enter, so the written value carries a trailing newline that
        // ProseMirror serializes out. The write landed; only the line end collapsed, so it must verify.
        let recorder = Recorder()
        recorder.readBack = "draft prompt"
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt\n", to: target(homeSpaceID: 1)) == .success("draft prompt"))
    }

    @Test func aDraftWithTrailingBlankLinesReadsBackWithOneFewer() {
        // A draft ending in blank paragraphs persists them minus the one empty final line. The read-back
        // still holds the content the user asked for; comparing the persisted line ends accepts it.
        let recorder = Recorder()
        recorder.readBack = "draft prompt\n\n"
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt\n\n\n", to: target(homeSpaceID: 1)) == .success("draft prompt\n\n"))
    }

    @Test func aReadBackMissingContentIsStillARealMismatch() {
        // Only line-end collapse is tolerated. A read-back that lost interior content means the write
        // did not land as intended and must be reported rather than believed.
        let recorder = Recorder()
        recorder.readBack = "draft"
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        #expect(writer.write("draft prompt\n", to: target(homeSpaceID: 1)) == .failure(.verifyMismatch))
    }

    @Test func lineEndCanonicalStripsOnlyTrailingNewlines() {
        #expect(AgentWindowComposerWriter.lineEndCanonical("") == "")
        #expect(AgentWindowComposerWriter.lineEndCanonical("draft prompt") == "draft prompt")
        #expect(AgentWindowComposerWriter.lineEndCanonical("draft prompt\n") == "draft prompt")
        #expect(AgentWindowComposerWriter.lineEndCanonical("draft prompt\n\n\n") == "draft prompt")
        // Interior and leading newlines are content, not a collapsed empty final line.
        #expect(AgentWindowComposerWriter.lineEndCanonical("line one\nline two") == "line one\nline two")
        #expect(AgentWindowComposerWriter.lineEndCanonical("\nlead") == "\nlead")
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

    @Test func aSubmitWritesThenPressesReturnAndReportsTheClearedField() {
        // The Enter action commits: write the prompt, then press Return. The cleared read-back is the
        // success signal -- no verify-mismatch, because an empty field is what a landed send produces.
        let recorder = Recorder()
        recorder.readBack = ""
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.writeAndSubmit("run the tests", to: target(homeSpaceID: 1))

        #expect(result == .success(""))
        #expect(recorder.steps == [.latch(400), .write("run the tests"), .submit])
    }

    @Test func aSubmitThatFailsToClearIsReportedWithTheTextItStillHolds() {
        // Chromium runs the commit on its own thread; if it has not cleared by the settle deadline, the
        // field is reported holding whatever it still has, so the panel sees the send did not land.
        let recorder = Recorder()
        recorder.readBack = "run the tests"
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.writeAndSubmit("run the tests", to: target(homeSpaceID: 1))

        #expect(result == .success("run the tests"))
        #expect(recorder.steps == [.latch(400), .write("run the tests"), .submit])
    }

    @Test func aSubmitOnAnotherDesktopFrontsTheWindowButStillPutsItBack() {
        // Unlike a plain write, submitting activates the owning window -- pressing Return is the user
        // asking for the prompt to run -- so a changed frontmost app is success, not the focus-stolen
        // failure the non-activating write path reports.
        let recorder = Recorder()
        recorder.readBack = ""
        recorder.frontmost = [100, 400]
        let writer = AgentWindowComposerWriter(access: recorder, placement: recorder)

        let result = writer.writeAndSubmit("run the tests", to: target(homeSpaceID: 4))

        #expect(result == .success(""))
        #expect(recorder.steps == [
            .latch(400),
            .move(windowID: 42, spaceID: 1),
            .awaitComposer,
            .write("run the tests"),
            .submit,
            .move(windowID: 42, spaceID: 4),
        ])
    }
}
