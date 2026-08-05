import Foundation

/// Which position in a workspace's terminal cascade the next terminal takes.
///
/// The window registry is the authority on the positions already in use, but it cannot answer for a
/// terminal that has been asked for and has not finished spawning: a window is only in the registry
/// once it exists. Two "＋ Terminal" clicks in quick succession would otherwise both read the same set
/// of open positions and both take the lowest free one, landing the second window exactly on top of
/// the first and giving the two the same name in the top bar's chooser.
///
/// So this holds only what the registry cannot know -- the claims still in flight -- rather than a
/// second copy of which terminals are open.
struct WorkspaceTerminalCascade {
    private var claimed: [UUID: Set<Int>] = [:]

    /// Takes the lowest position that is neither already open nor already claimed, and holds it until
    /// `release`. Lowest free rather than a running count: closing a terminal in the middle of a
    /// cascade gives its place back, instead of pushing every later spawn further off the slot.
    mutating func claim(workspace: UUID, open: Set<Int>) -> Int {
        let held = claimed[workspace] ?? []
        var ordinal = 0
        while open.contains(ordinal) || held.contains(ordinal) {
            ordinal += 1
        }
        claimed[workspace, default: []].insert(ordinal)
        return ordinal
    }

    /// Gives a claim back, whether the terminal opened -- the registry holds its position from then on
    /// -- or failed to, in which case nothing holds it. A claim that is never released is a position
    /// lost for the life of the host.
    mutating func release(workspace: UUID, ordinal: Int) {
        claimed[workspace]?.remove(ordinal)
        if claimed[workspace]?.isEmpty == true {
            claimed[workspace] = nil
        }
    }

    /// The claims still in flight for one workspace, for a test that needs to see them released.
    func claimedOrdinalsForTesting(workspace: UUID) -> Set<Int> {
        claimed[workspace] ?? []
    }
}
