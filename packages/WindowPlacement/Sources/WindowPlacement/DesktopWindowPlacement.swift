import CoreGraphics
import Foundation

public struct DesktopWindowAssignment: Codable, Equatable, Sendable {
    public let spaceID: UInt64
    public let displayID: String
    public let ordinal: Int

    public init(spaceID: UInt64, displayID: String, ordinal: Int) {
        self.spaceID = spaceID
        self.displayID = displayID
        self.ordinal = ordinal
    }

}

public struct DesktopWindowPlacement: Codable, Equatable, Sendable {
    public let desktop: DesktopWindowAssignment
    public var frame: CGRect

    public init(desktop: DesktopWindowAssignment, frame: CGRect) {
        self.desktop = desktop
        self.frame = frame
    }

    public var isValid: Bool {
        desktop.spaceID > 0
            && !desktop.displayID.isEmpty
            && desktop.displayID.utf8.count <= 256
            && desktop.ordinal >= 0
            && frame.origin.x.isFinite
            && frame.origin.y.isFinite
            && frame.width.isFinite
            && frame.height.isFinite
            && frame.width >= 1
            && frame.height >= 1
    }
}
