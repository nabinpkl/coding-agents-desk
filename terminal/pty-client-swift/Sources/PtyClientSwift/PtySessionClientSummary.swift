import Foundation

public struct PtySessionClientSummary: Equatable, Sendable {
    public let id: UInt64
    public let title: String
    public let active: Bool
    public let dimensions: PtyTerminalDimensions
    public let isOwner: Bool

    public init(
        id: UInt64,
        title: String,
        active: Bool = false,
        dimensions: PtyTerminalDimensions = .bootstrap,
        isOwner: Bool = false
    ) {
        self.id = id
        self.title = title
        self.active = active
        self.dimensions = dimensions
        self.isOwner = isOwner
    }
}
