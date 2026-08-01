import Foundation

/// Holds the deadline for one blocked stretch of a dial.
///
/// Its whole job is that `arm` is idempotent. A blocked connection re-reports the same block
/// repeatedly -- the measured dial logged `waiting(ENETDOWN)` again and again over 11.7s -- so a
/// watchdog that restarted on every update would push its own deadline out forever and never
/// fire. The deadline belongs to the blocked stretch, not to the last update inside it, and only
/// leaving the block (or finishing the dial) clears it.
///
/// That failure mode is invisible from the outside: a bound that never fires looks exactly like
/// the unbounded wait it was added to replace. Hence its own type, and its own tests.
final class BlockedDialWatchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var deadline: Task<Void, Never>?

    var isArmed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return deadline != nil
    }

    /// Starts a deadline for this blocked stretch, or does nothing if one is already running.
    func arm(_ makeDeadline: () -> Task<Void, Never>) {
        lock.lock()
        defer { lock.unlock() }
        guard deadline == nil else { return }
        deadline = makeDeadline()
    }

    /// Ends the blocked stretch. Safe to call when nothing is armed, which is the common case:
    /// every terminal state calls it whether or not the dial ever blocked.
    func disarm() {
        lock.lock()
        let pending = deadline
        deadline = nil
        lock.unlock()
        // Cancelled outside the lock: the deadline task takes its own locks on the way out.
        pending?.cancel()
    }
}
