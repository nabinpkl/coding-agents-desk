import Foundation

/// Decides when a path that just moved has stopped moving.
///
/// Redialing the instant a link changes binds the new connection to the interface that is on
/// its way out. Measured across two WiFi-to-cellular handovers, that dial came up, opened a
/// stream, sent its resume init, and then read zero bytes -- the old interface died underneath
/// it. Four of every six seconds of outage were spent inside that doomed attempt, and the
/// redial after it connected in one.
///
/// So the gate is not "is the path usable" but "has it held still". A path mid-handover reports
/// satisfied on the interface it is about to drop, which is exactly the reading that misleads.
///
/// Pure and clock-injected: the situation it exists for -- a real phone moving between real
/// networks -- is the one that cannot be reproduced on demand, and `NWPath` cannot be
/// constructed. Deciding here rather than inside the monitor callback is what makes the
/// behaviour testable at all.
public struct NetworkPathSettleGate: Equatable, Sendable {
    private let debounceMs: Int
    private var current: LinkPathSnapshot?
    private var unchangedSinceMs: Int?

    public init(debounceMs: Int) {
        self.debounceMs = max(0, debounceMs)
    }

    /// Feed every observed snapshot. One that differs from the last restarts the window, so a
    /// flapping path never satisfies the gate no matter how often it passes through satisfied.
    public mutating func observe(_ snapshot: LinkPathSnapshot, atMs: Int) {
        guard current != snapshot else { return }
        current = snapshot
        unchangedSinceMs = atMs
    }

    /// Settled means the path can carry traffic *and* has looked that way for the whole window.
    ///
    /// Unknown counts as unsettled: having observed nothing is not evidence the path is calm,
    /// and the caller bounds the wait with its own timeout rather than relying on this to
    /// eventually say yes.
    public func hasSettled(atMs: Int) -> Bool {
        guard let current, current.status == "satisfied" else { return false }
        guard let unchangedSinceMs else { return false }
        return atMs - unchangedSinceMs >= debounceMs
    }
}
