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
        let projects = try await client.fetchDigest()
        return projects.contains { project in
            guard canonicalProjectPath(project.project) == identity.projectDirectory.path else {
                return false
            }
            var sessions = project.sessions ?? []
            sessions.append(contentsOf: project.otherSessions ?? [])
            if let primary = project.primary {
                sessions.append(primary)
            }
            return sessions.contains { session in
                session.source == identity.source.rawValue
                    && canonicalSessionID(session.sessionId) == identity.harnessSessionID
                    && session.bin == "live"
            }
        }
    }

    private func canonicalProjectPath(_ path: String) -> String? {
        guard (path as NSString).isAbsolutePath else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    private func canonicalSessionID(_ rawValue: String) -> String? {
        UUID(uuidString: rawValue)?.uuidString.lowercased()
    }
}
