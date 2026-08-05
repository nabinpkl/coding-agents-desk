import Foundation

/// Which family of independent window a chooser is listing. The two behave identically once open --
/// each is a UUID-backed instance on a Desktop, listed, gone to, and closed the same way -- so they
/// share one summary, one menu, and one set of registry operations, and differ only in what they are
/// called and what their controls are identified as.
enum WorkspaceWindowKind: String {
    case agents
    case ide

    /// How the window is named to the user. "IDE" stays upper-case; it is an initialism, not a word.
    var label: String {
        switch self {
        case .agents: return "Agents"
        case .ide: return "IDE"
        }
    }

    /// Prefix for the chooser's accessibility identifiers, so a UI test can say which family's list
    /// it is driving.
    var identifierPrefix: String { rawValue }
}

/// One open window, as a chooser needs to describe it.
///
/// Deliberately not the window itself: the top bar lists windows it does not own and must not be able
/// to reach into, and a value also survives the window closing between the list being built and a row
/// being clicked.
struct WorkspaceWindowSummary: Equatable, Identifiable {
    let id: UUID
    let kind: WorkspaceWindowKind
    /// The Desktop the window sits on, as an index into its display's Spaces. Zero-based, like the
    /// assignment it comes from.
    let desktopOrdinal: Int
    /// Its place in that Desktop's cascade, which is what distinguishes two windows on one Desktop.
    /// Zero-based, like the registry's own cascade bookkeeping.
    let cascadeOrdinal: Int

    /// Names the window by where it is rather than by what it contains. A window's contents change as
    /// the user works, so a title taken from them would not still identify the same window a moment
    /// later; its Desktop and cascade position do.
    ///
    /// Both ordinals are counted from zero internally and shown from one, because Mission Control
    /// labels the first Desktop "Desktop 1" and a chooser that disagreed with it would be naming a
    /// different Desktop than the one the user is looking at.
    var title: String {
        "\(kind.label) \(cascadeOrdinal + 1) · Desktop \(desktopOrdinal + 1)"
    }
}

/// Makes one Desktop the active one and answers whether it got there. Injected into the registries
/// rather than reached for, so they can be tested without a live WindowServer, and left nil when the
/// host has no Spaces authority at all, in which case a listed window is raised where it stands.
typealias DesktopActivating = @MainActor (WorkspaceDesktopAssignment) async -> Bool

extension WorkspaceDesktopSwitcher {
    /// Waits for the Space to actually be the active one rather than for the gesture to be accepted:
    /// raising a window while the transition is still in flight lands it behind whatever the Desktop
    /// settles on.
    func activate(_ desktop: WorkspaceDesktopAssignment) async -> Bool {
        let confirmation = try? await switchToDesktopAndWait(
            spaceID: desktop.spaceID,
            displayID: desktop.displayID
        )
        return confirmation == .reached
    }
}
