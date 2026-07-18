import Foundation

/// A live macOS Desktop (Space). `ordinal` is scoped to `displayID` and remains the control coordinate
/// used by workspace assignment and switching. `missionControlOrdinal` is global across displays in
/// SkyLight order and exists only for Mission Control-compatible presentation.
public struct WorkspaceDesktop: Equatable, Sendable {
    public let id: UInt64
    public let displayID: String
    public let ordinal: Int
    public let missionControlOrdinal: Int
    public let isActive: Bool

    public init(
        id: UInt64,
        displayID: String,
        ordinal: Int,
        missionControlOrdinal: Int,
        isActive: Bool
    ) {
        self.id = id
        self.displayID = displayID
        self.ordinal = ordinal
        self.missionControlOrdinal = missionControlOrdinal
        self.isActive = isActive
    }
}
