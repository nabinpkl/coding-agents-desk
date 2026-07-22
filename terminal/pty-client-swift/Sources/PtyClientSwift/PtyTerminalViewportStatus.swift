import Foundation

public struct PtyTerminalViewportStatus: Equatable, Sendable {
    public let ownershipEpoch: UInt64
    public let ownerClientID: UInt64
    public let ownerTitle: String
    public let isOwner: Bool
    public let sourceDimensions: PtyTerminalDimensions
    public let sourceRevision: UInt64
    public let viewDimensions: PtyTerminalDimensions

    public init(
        ownershipEpoch: UInt64,
        ownerClientID: UInt64,
        ownerTitle: String,
        isOwner: Bool,
        sourceDimensions: PtyTerminalDimensions,
        sourceRevision: UInt64,
        viewDimensions: PtyTerminalDimensions
    ) {
        self.ownershipEpoch = ownershipEpoch
        self.ownerClientID = ownerClientID
        self.ownerTitle = ownerTitle
        self.isOwner = isOwner
        self.sourceDimensions = sourceDimensions
        self.sourceRevision = sourceRevision
        self.viewDimensions = viewDimensions
    }
}
