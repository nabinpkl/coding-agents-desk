import Foundation
import Testing

@testable import AgentDeskHost

/// Where a new terminal lands. Spawning is asynchronous, so the interesting cases are all about the
/// gap between a terminal being asked for and its window existing: nothing else can see a position is
/// taken during that window, and two terminals sharing one both stack on screen and read as the same
/// row in the top bar's chooser.
struct WorkspaceTerminalCascadeTests {
    private let workspace = UUID()
    private let other = UUID()

    @Test func theFirstTerminalInAnEmptyWorkspaceTakesTheFirstPosition() {
        var cascade = WorkspaceTerminalCascade()

        #expect(cascade.claim(workspace: workspace, open: []) == 0)
    }

    @Test func twoClicksBeforeEitherWindowExistsTakeDifferentPositions() {
        var cascade = WorkspaceTerminalCascade()

        // Both read the same set of open windows, because neither has registered yet. This is the
        // race the claims exist for.
        let first = cascade.claim(workspace: workspace, open: [])
        let second = cascade.claim(workspace: workspace, open: [])

        #expect(first == 0)
        #expect(second == 1)
    }

    @Test func aPositionAClosedTerminalLeftBehindIsUsedAgain() {
        var cascade = WorkspaceTerminalCascade()

        // Three terminals opened, the middle one closed. Counting from the number still open would
        // answer 2 and stack the new window on the last one.
        #expect(cascade.claim(workspace: workspace, open: [0, 2]) == 1)
    }

    @Test func aClaimIsGivenBackOnceTheWindowIsRegistered() {
        var cascade = WorkspaceTerminalCascade()
        let claimed = cascade.claim(workspace: workspace, open: [])

        cascade.release(workspace: workspace, ordinal: claimed)

        #expect(cascade.claimedOrdinalsForTesting(workspace: workspace).isEmpty)
        // The registry answers for position 0 from here, so the claim must not still be holding it --
        // otherwise every spawn after the first would step one further off the slot.
        #expect(cascade.claim(workspace: workspace, open: [0]) == 1)
    }

    @Test func aClaimIsGivenBackWhenTheTerminalFailsToSpawn() {
        var cascade = WorkspaceTerminalCascade()
        let claimed = cascade.claim(workspace: workspace, open: [])

        cascade.release(workspace: workspace, ordinal: claimed)

        // Nothing opened, so nothing holds the position and the next attempt should get it back.
        #expect(cascade.claim(workspace: workspace, open: []) == 0)
    }

    @Test func oneWorkspacesClaimsDoNotMoveAnothersTerminals() {
        var cascade = WorkspaceTerminalCascade()
        _ = cascade.claim(workspace: workspace, open: [])

        // Each workspace is its own Desktop with its own cascade, so a claim in one must not push the
        // first terminal of another off the slot.
        #expect(cascade.claim(workspace: other, open: []) == 0)
    }
}
