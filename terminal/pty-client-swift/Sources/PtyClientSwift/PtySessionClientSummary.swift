import Foundation

public struct PtySessionClientSummary: Equatable, Sendable {
    public let id: UInt64
    public let title: String

    public init(id: UInt64, title: String) {
        self.id = id
        self.title = title
    }
}
