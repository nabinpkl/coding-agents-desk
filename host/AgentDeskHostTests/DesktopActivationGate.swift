import Foundation

@testable import AgentDeskHost

/// Stands in for the Desktop switch, held open so a test can look at the world between "asked to
/// switch" and "arrived" -- the window in that gap is the whole point of ordering the two.
///
/// Shared by every window family: they run the same two-step through one reveal, so a divergence
/// between copies of the fake would hide a divergence between the callers.
@MainActor
final class DesktopActivationGate {
    private(set) var requested: [WorkspaceDesktopAssignment] = []
    private var continuation: CheckedContinuation<Bool, Never>?

    func activate(_ desktop: WorkspaceDesktopAssignment) async -> Bool {
        requested.append(desktop)
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func complete(reached: Bool) {
        continuation?.resume(returning: reached)
        continuation = nil
    }
}
