public struct PtyTerminalDimensions: Equatable, Sendable {
    public static let bootstrap = PtyTerminalDimensions(columns: 80, rows: 24)

    public let columns: UInt32
    public let rows: UInt32

    public init(columns: UInt32, rows: UInt32) {
        precondition(columns > 0, "terminal columns must be positive")
        precondition(rows > 0, "terminal rows must be positive")
        self.columns = columns
        self.rows = rows
    }
}
