import Foundation
import Testing

@testable import AgentDeskHost

/// The renderer-revive recovery, fed the exact process-table shapes the resolver parses.
///
/// The recovery exists because a Claude window's conversation pane can be wedged -- the composer is on
/// screen, but the web contents never built its accessibility tree, so the composer scan reads
/// "missing". Terminating the `--type=renderer` children of the Claude main pid makes Chromium respawn
/// the contents fresh, which materializes the tree. These tests pin the selection (parent pid + the
/// Chromium renderer marker only), the termination, and the two gates that keep the kill from becoming
/// a nuisance: the composer must be missing CONTINUOUSLY for `minMissing`, and one kill per Claude
/// process per cooldown.
struct AgentWindowRendererReviverTests {
    private static func row(_ pid: Int, _ ppid: Int, _ arguments: String) -> AgentWindowProcessRow {
        AgentWindowProcessRow(pid: pid_t(pid), parentPid: pid_t(ppid), arguments: arguments)
    }

    private static let rendererArgs =
        "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --renderer-client-id=7"

    private static func fixtureRows() -> [AgentWindowProcessRow] {
        [
            row(800, 1, "/Applications/Claude.app/Contents/MacOS/Claude"),
            row(810, 800, rendererArgs),
            row(811, 800, "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --renderer-client-id=5"),
            row(812, 800, "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process"),
            row(813, 800, "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility --utility-sub-type=network.mojom.NetworkService"),
            row(814, 800, "/Applications/Claude.app/Contents/Helpers/disclaimer"),
            row(910, 900, rendererArgs),
        ]
    }

    private final class Killed: @unchecked Sendable {
        var pids: [pid_t] = []
    }

    private func makeReviver(
        rows: @escaping () -> [AgentWindowProcessRow] = fixtureRows,
        killed: Killed
    ) -> AgentWindowRendererReviver {
        AgentWindowRendererReviver(
            processRows: rows,
            terminate: { killed.pids.append($0) },
            minMissing: 8,
            cooldown: 60
        )
    }

    @Test func terminatesOnlyTheRenderersOfTheGivenMainPid() {
        let rows = Self.fixtureRows()
        let terminated = AgentWindowRendererReviver.rendererPids(of: 800, in: rows)
        #expect(terminated == [810, 811])
    }

    @Test func aMainPidWithNoRendererChildrenTerminatesNothing() {
        let rows = [Self.row(800, 1, "/Applications/Claude.app/Contents/MacOS/Claude")]
        let terminated = AgentWindowRendererReviver.rendererPids(of: 800, in: rows)
        #expect(terminated.isEmpty)
    }

    @Test func aRendererOfAnotherClaudeInstanceIsLeftAlone() {
        let rows = Self.fixtureRows()
        let terminated = AgentWindowRendererReviver.rendererPids(of: 900, in: rows)
        #expect(terminated == [910])
        let otherTerminated = AgentWindowRendererReviver.rendererPids(of: 800, in: rows)
        #expect(otherTerminated == [810, 811])
    }

    @Test func aSingleMissingObservationRecordsButDoesNotKill() {
        let killed = Killed()
        let reviver = makeReviver(killed: killed)
        let result = reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_000))
        #expect(result.isEmpty)
        #expect(killed.pids.isEmpty)
    }

    @Test func aPersistentMissingKillsOnceTheThresholdIsReached() {
        let killed = Killed()
        let reviver = makeReviver(killed: killed)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_000)).isEmpty)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_007)).isEmpty)
        let result = reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_008))
        #expect(result == [810, 811])
        #expect(killed.pids == [810, 811])
    }

    @Test func aFoundComposerResetsTheMissingStreak() {
        // A tree that flaps -- missing for a second, found for ten -- is never killed, because the
        // gate measures CONTINUOUS missing time, not accumulated wall time.
        let killed = Killed()
        let reviver = makeReviver(killed: killed)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_000)).isEmpty)
        reviver.noteComposerFound(for: 800)
        let result = reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_010))
        #expect(result.isEmpty)
        #expect(killed.pids.isEmpty)
    }

    @Test func theCooldownSuppressesRepeatedKillsOfTheSameProcess() {
        let killed = Killed()
        let reviver = makeReviver(killed: killed)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_000)).isEmpty)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_008)) == [810, 811])
        // Still continuously missing, but within the cooldown: no second kill.
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_020)).isEmpty)
        #expect(killed.pids == [810, 811])
        // Past the cooldown, still missing: revived again.
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_069)) == [810, 811])
        #expect(killed.pids == [810, 811, 810, 811])
    }

    @Test func theStreakAndCooldownArePerClaudeProcess() {
        let killed = Killed()
        let reviver = makeReviver(killed: killed)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_000)).isEmpty)
        #expect(reviver.noteComposerMissing(for: 900, now: Date(timeIntervalSince1970: 1_000)).isEmpty)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_008)) == [810, 811])
        #expect(reviver.noteComposerMissing(for: 900, now: Date(timeIntervalSince1970: 1_008)) == [910])
        #expect(killed.pids == [810, 811, 910])
    }

    @Test func aReviveWithNoLiveRenderersKillsNothingAndRecordsNothing() {
        let killed = Killed()
        let reviver = makeReviver(
            rows: { [Self.row(800, 1, "/Applications/Claude.app/Contents/MacOS/Claude")] },
            killed: killed
        )
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_000)).isEmpty)
        #expect(reviver.noteComposerMissing(for: 800, now: Date(timeIntervalSince1970: 1_010)).isEmpty)
        #expect(killed.pids.isEmpty)
    }
}
