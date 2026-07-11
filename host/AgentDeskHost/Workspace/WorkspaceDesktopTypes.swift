import CoreGraphics
import Foundation

/// Live macOS Desktop (Space) value types, ported from the agent-workspace-ide donor. Pure value
/// shapes used by the workspace store's desktop ops and the desktop-switch adapters (over
/// AgentDesk's SpacesProvider). The app-owner classification uses this app's process name.
public struct WorkspaceDesktop: Equatable {
    public let id: UInt64
    public let displayID: String
    public let ordinal: Int
    public let isActive: Bool

    public init(id: UInt64, displayID: String, ordinal: Int, isActive: Bool) {
        self.id = id
        self.displayID = displayID
        self.ordinal = ordinal
        self.isActive = isActive
    }
}

public enum WorkspaceDesktopWindowExpectation: Equatable {
    case appAssignedDesktop
    case appAllSpacesControl
    case otherApp

    /// This app's window owner name as reported by CGWindowListCopyWindowInfo.
    static let appOwnerName = "AgentDeskHost"

    static func classify(owner: String, title: String) -> WorkspaceDesktopWindowExpectation {
        guard owner == appOwnerName else { return .otherApp }
        switch title {
        case "Workspace Sidebar", "Workspace Top Bar", "AX Controls":
            return .appAllSpacesControl
        default:
            return .appAssignedDesktop
        }
    }

    var description: String {
        switch self {
        case .appAssignedDesktop: return "assigned"
        case .appAllSpacesControl: return "all-spaces"
        case .otherApp: return "other"
        }
    }
}

public struct WorkspaceDesktopWindow: Equatable {
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

public struct WorkspaceDesktopSnapshot: Equatable {
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
