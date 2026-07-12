import CoreGraphics
import Foundation

/// The window/desktop audit the dock-enrichment reader consumes (ADR-0054). Ported from the
/// agent-workspace-ide donor, minus the donor's own `SkyLightDesktopBinding`: AgentDesk already owns
/// a SkyLight binding in `SpacesProvider`, so the concrete `HostWorkspaceDesktopAudit` backs onto that
/// single private-API source (`skyLightDesktopAuditSnapshot()`) rather than opening a second one.
/// Reuses the host's existing `WorkspaceDesktop`; only the window/snapshot value types are new here.

public enum WorkspaceDesktopWindowExpectation: Equatable, Sendable {
    case appAssignedDesktop
    case appAllSpacesControl
    case otherApp

    /// Windows the shell owns that float on every Space (the reveal chrome) versus its per-desktop
    /// editor/terminal windows versus everything else. Only used for the diagnostic report; the
    /// reader groups purely on `spaceIDs`.
    static func classify(owner: String, title: String) -> WorkspaceDesktopWindowExpectation {
        guard owner == hostOwnerName else { return .otherApp }
        switch title {
        case WorkspaceShellControlWindow.sidebar,
             WorkspaceShellControlWindow.topBar,
             WorkspaceShellControlWindow.dockEnrichment:
            return .appAllSpacesControl
        default:
            return .appAssignedDesktop
        }
    }

    /// The host app's CGWindow owner name (its process name), computed once.
    static let hostOwnerName = ProcessInfo.processInfo.processName

    var description: String {
        switch self {
        case .appAssignedDesktop: return "assigned"
        case .appAllSpacesControl: return "all-spaces"
        case .otherApp: return "other"
        }
    }
}

/// The title strings the host's reveal-chrome panels carry, so the audit + reader can recognize and
/// hide the shell's own overlay windows from the enrichment view. Set on the panels in the overlay.
public enum WorkspaceShellControlWindow {
    public static let sidebar = "AgentDesk Sidebar"
    public static let topBar = "AgentDesk Top Bar"
    public static let dockEnrichment = "AgentDesk Dock Enrichment"

    public static let all: Set<String> = [sidebar, topBar, dockEnrichment]
}

public struct WorkspaceDesktopWindow: Equatable, Sendable {
    public let windowID: UInt32
    public let ownerName: String
    public let title: String
    public var spaceID: UInt64? { spaceIDs.first }
    public let spaceIDs: [UInt64]
    public let layer: Int
    public let bounds: CGRect
    public let expectation: WorkspaceDesktopWindowExpectation

    public init(
        windowID: UInt32,
        ownerName: String,
        title: String,
        spaceIDs: [UInt64],
        layer: Int,
        bounds: CGRect,
        expectation: WorkspaceDesktopWindowExpectation
    ) {
        self.windowID = windowID
        self.ownerName = ownerName
        self.title = title
        self.spaceIDs = spaceIDs
        self.layer = layer
        self.bounds = bounds
        self.expectation = expectation
    }
}

public struct WorkspaceDesktopSnapshot: Equatable, Sendable {
    public let activeSpaceID: UInt64?
    public let desktops: [WorkspaceDesktop]
    public let windows: [WorkspaceDesktopWindow]
    public let diagnostic: String?

    public init(activeSpaceID: UInt64?, desktops: [WorkspaceDesktop], windows: [WorkspaceDesktopWindow], diagnostic: String?) {
        self.activeSpaceID = activeSpaceID
        self.desktops = desktops
        self.windows = windows
        self.diagnostic = diagnostic
    }

    public var isAvailable: Bool { activeSpaceID != nil && diagnostic == nil }

    public static func unavailable(_ message: String) -> WorkspaceDesktopSnapshot {
        WorkspaceDesktopSnapshot(activeSpaceID: nil, desktops: [], windows: [], diagnostic: message)
    }
}

/// The audit surface the reader depends on. `snapshot()` is called off the main thread on the reader's
/// utility queue, so conformers must be safe there.
public protocol WorkspaceDesktopAuditing: Sendable {
    func snapshot() -> WorkspaceDesktopSnapshot
}

/// Production audit: the single host SkyLight source (`skyLightDesktopAuditSnapshot()` in
/// SpacesProvider), which uses only SkyLight + CGWindowList (no NSScreen), so it is off-main safe.
public struct HostWorkspaceDesktopAudit: WorkspaceDesktopAuditing {
    public init() {}
    public func snapshot() -> WorkspaceDesktopSnapshot { skyLightDesktopAuditSnapshot() }
}

/// Static audit for tests.
public struct StaticWorkspaceDesktopAudit: WorkspaceDesktopAuditing {
    public let current: WorkspaceDesktopSnapshot
    public init(_ current: WorkspaceDesktopSnapshot) { self.current = current }
    public func snapshot() -> WorkspaceDesktopSnapshot { current }
}
