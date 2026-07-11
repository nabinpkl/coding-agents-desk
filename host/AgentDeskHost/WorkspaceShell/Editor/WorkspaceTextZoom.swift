import CoreGraphics

public struct WorkspaceTextZoom: Codable, Equatable, Sendable {
    public static let minimumStep = -3
    public static let maximumStep = 8

    public let step: Int

    public init(step: Int = 0) {
        self.step = min(Self.maximumStep, max(Self.minimumStep, step))
    }

    private enum CodingKeys: String, CodingKey {
        case step
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(step: try container.decode(Int.self, forKey: .step))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(step, forKey: .step)
    }

    public var sidebarLabelPointSize: CGFloat { min(42, max(10, CGFloat(12 + (step * 2)))) }
    public var sidebarBadgePointSize: CGFloat { min(38, max(9, CGFloat(11 + (step * 2)))) }
    public var sidebarIconPointSize: CGFloat { min(32, max(12, CGFloat(16 + (step * 2)))) }
    public var fileTreeLabelPointSize: CGFloat { min(54, max(10, CGFloat(12 + (step * 2)))) }
    public var sidebarRowHeight: CGFloat { max(20, max(fileTreeLabelPointSize + 12, sidebarIconPointSize + 8)) }
    public var editorCodePointSize: CGFloat { 12.5 + CGFloat(step) }
    public var markdownPointSize: CGFloat { 13 + CGFloat(step) }
    public var terminalPointSize: CGFloat { 14 + CGFloat(step) }

    public func zoomedIn() -> WorkspaceTextZoom {
        WorkspaceTextZoom(step: step + 1)
    }

    public func zoomedOut() -> WorkspaceTextZoom {
        WorkspaceTextZoom(step: step - 1)
    }

    public func reset() -> WorkspaceTextZoom {
        WorkspaceTextZoom()
    }
}
