import Foundation

public struct PtyTerminalCheckpoint: Equatable, Sendable {
    public let checkpointID: UInt64
    public let revision: UInt64
    public let columns: UInt32
    public let rows: UInt32
    public let totalBytes: UInt64
    public let chunkCount: UInt32
    public let historyTruncated: Bool

    public init(
        checkpointID: UInt64,
        revision: UInt64,
        columns: UInt32,
        rows: UInt32,
        totalBytes: UInt64,
        chunkCount: UInt32,
        historyTruncated: Bool
    ) {
        self.checkpointID = checkpointID
        self.revision = revision
        self.columns = columns
        self.rows = rows
        self.totalBytes = totalBytes
        self.chunkCount = chunkCount
        self.historyTruncated = historyTruncated
    }
}

public enum PtySessionEvent: Equatable, Sendable {
    case attached(PtySessionAttachment)
    case checkpointBegan(PtyTerminalCheckpoint)
    case checkpointChunk(checkpointID: UInt64, index: UInt32, data: Data)
    case checkpointEnded(checkpointID: UInt64, revision: UInt64)
    case output(data: Data, revision: UInt64)
    case detachedByManager(UInt64)
    case exited(Int32)
    case error(String)
}
