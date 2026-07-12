import Foundation

public struct PtySessionAttachment: Equatable, Sendable {
    public let name: String
    public let pid: UInt32
    public let cwd: String
    public let shell: String
    public let clientCount: UInt32
    public let clientID: UInt64

    public init(
        name: String,
        pid: UInt32,
        cwd: String,
        shell: String,
        clientCount: UInt32,
        clientID: UInt64
    ) {
        self.name = name
        self.pid = pid
        self.cwd = cwd
        self.shell = shell
        self.clientCount = clientCount
        self.clientID = clientID
    }
}
