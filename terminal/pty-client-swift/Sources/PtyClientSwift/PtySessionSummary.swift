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
        clients: [PtySessionClientSummary]
    ) {
        self.name = name
        self.cwd = cwd
        self.shell = shell
        self.pid = pid
        self.state = state
        self.clients = clients
    }
}
