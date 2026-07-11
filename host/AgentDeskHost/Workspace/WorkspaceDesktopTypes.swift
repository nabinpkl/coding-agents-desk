import Foundation

/// A live macOS Desktop (Space) row, ported from the agent-workspace-ide donor. Used by the workspace
/// store's desktop ops (`orderByDesktopEnumeration`) and `WorkspaceDesktopSwitcher`. The donor's
/// window/audit value types are not ported (AgentDesk has no desktop-audit surface).
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
