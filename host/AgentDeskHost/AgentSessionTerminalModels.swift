import Foundation

struct AgentSessionTerminalRequestTombstones {
    private let limit: Int
    private var requestIDs: Set<String> = []
    private var insertionOrder: [String] = []

    init(limit: Int) {
        precondition(limit > 0, "Agent terminal tombstone limit must be positive")
        self.limit = limit
    }

    func contains(_ requestID: String) -> Bool {
        requestIDs.contains(requestID)
    }

    mutating func insert(_ requestID: String) {
        guard requestIDs.insert(requestID).inserted else { return }
        insertionOrder.append(requestID)
        if insertionOrder.count > limit {
            requestIDs.remove(insertionOrder.removeFirst())
        }
    }

    mutating func removeAll() {
        requestIDs.removeAll(keepingCapacity: false)
        insertionOrder.removeAll(keepingCapacity: false)
    }

    var orderedRequestIDs: [String] {
        insertionOrder
    }
}

struct AgentSessionTerminalContext: Equatable, Sendable {
    let projectPath: String
    let source: String
    let harnessSessionID: String
}

enum AgentSessionTerminalPlatform: String, Equatable, Sendable {
    case macOS = "macos"
    case iOS = "ios"

    var bootstrapClientTitle: String {
        "agent-panel-bootstrap-\(rawValue)"
    }
}

struct AgentSessionTerminalOpenRequest: Equatable, Sendable {
    let requestID: String
    let context: AgentSessionTerminalContext
    let platform: AgentSessionTerminalPlatform
}

struct AgentSessionTerminalReady: Equatable, Sendable {
    let requestID: String
    let identity: AgentResumeTerminalIdentity
    let pid: UInt32

    var ptySessionName: String {
        identity.ptySessionName
    }
}

enum AgentSessionTerminalCoordinatorError: Error, Equatable, Sendable {
    case invalidContext(AgentResumeValidationError)
    case activeElsewhere
    case launchFailed(String)
    case handoffTimedOut
    case sessionEnded
}

enum AgentSessionTerminalCoordinatorEvent: Equatable, Sendable {
    case handoffTimedOut(requestID: String, ready: AgentSessionTerminalReady)
}

protocol AgentSessionTerminalLivenessChecking: Sendable {
    func isLive(_ identity: AgentResumeTerminalIdentity) async throws -> Bool
}

struct SidecarAgentSessionTerminalLivenessChecker: AgentSessionTerminalLivenessChecking {
    let client: any SidecarClient

    func isLive(_ identity: AgentResumeTerminalIdentity) async throws -> Bool {
        let snapshot = try await client.fetchSessions(
            projectPath: identity.projectDirectory.path
        )
        return snapshot.sessions.contains { session in
            session.source == identity.source.rawValue
                && canonicalSessionID(session.sessionId) == identity.harnessSessionID
                && session.activity == "live"
        }
    }

    private func canonicalSessionID(_ rawValue: String) -> String? {
        UUID(uuidString: rawValue)?.uuidString.lowercased()
    }
}
