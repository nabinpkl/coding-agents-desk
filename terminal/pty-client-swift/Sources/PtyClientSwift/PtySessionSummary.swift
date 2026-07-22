import Foundation

public struct PtySessionSummary: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case running
        case exited
        case unspecified
    }

    public let name: String
    public let cwd: String
    public let shell: String
    public let pid: UInt32
    public let state: State
    public let lifetime: PtySessionLifetime
    public let startedAtUnixMilliseconds: UInt64
    public let columns: UInt32
    public let rows: UInt32
    public let revision: UInt64
    public let clients: [PtySessionClientSummary]

    public var clientCount: UInt32 {
        UInt32(clients.count)
    }

    public init(
        name: String,
        cwd: String,
        shell: String,
        pid: UInt32,
        state: State,
        lifetime: PtySessionLifetime,
        startedAtUnixMilliseconds: UInt64,
        columns: UInt32 = 80,
        rows: UInt32 = 24,
        revision: UInt64 = 1,
        clients: [PtySessionClientSummary]
    ) {
        self.name = name
        self.cwd = cwd
        self.shell = shell
        self.pid = pid
        self.state = state
        self.lifetime = lifetime
        self.startedAtUnixMilliseconds = startedAtUnixMilliseconds
        self.columns = columns
        self.rows = rows
        self.revision = revision
        self.clients = clients
    }
}
