import Foundation

public struct PtySessionAttachment: Equatable, Sendable {
    public let name: String
    public let pid: UInt32
    public let cwd: String
    public let shell: String
    public let clientCount: UInt32
    public let clientID: UInt64
    public let columns: UInt32
    public let rows: UInt32
    public let revision: UInt64
    public let ownerClientID: UInt64
    public let ownershipEpoch: UInt64

    public init(
        name: String,
        pid: UInt32,
        cwd: String,
        shell: String,
        clientCount: UInt32,
        clientID: UInt64,
        columns: UInt32 = 80,
        rows: UInt32 = 24,
        revision: UInt64 = 1,
        ownerClientID: UInt64 = 0,
        ownershipEpoch: UInt64 = 0
    ) {
        self.name = name
        self.pid = pid
        self.cwd = cwd
        self.shell = shell
        self.clientCount = clientCount
        self.clientID = clientID
        self.columns = columns
        self.rows = rows
        self.revision = revision
        self.ownerClientID = ownerClientID
        self.ownershipEpoch = ownershipEpoch
    }
}
