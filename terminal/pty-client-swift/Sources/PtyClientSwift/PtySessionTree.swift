import Foundation

public enum PtySessionTreeRow: Equatable, Sendable {
    case session(PtySessionSummary)
    case client(sessionName: String, client: PtySessionClientSummary)
}

public struct PtySessionTree: Equatable, Sendable {
    public var sessions: [PtySessionSummary]

    public init(sessions: [PtySessionSummary]) {
        self.sessions = sessions
    }

    public func numberOfChildren(of item: PtySessionTreeRow?) -> Int {
        switch item {
        case .none:
            return sessions.count
        case .session(let session):
            return session.clients.count
        case .client:
            return 0
        }
    }

    public func child(_ index: Int, of item: PtySessionTreeRow?) -> PtySessionTreeRow {
        switch item {
        case .none:
            return .session(sessions[index])
        case .session(let session):
            return .client(sessionName: session.name, client: session.clients[index])
        case .client:
            preconditionFailure("client rows do not have children")
        }
    }

    public func isExpandable(_ item: PtySessionTreeRow?) -> Bool {
        guard case .session(let session) = item else { return false }
        return !session.clients.isEmpty
    }
}
