import Foundation

/// Terminal sources remain closed because they select executable argv. Feed sources are separately
/// validated bounded strings so a registered provider such as Pi cannot gain PTY authority.
public enum AgentPanelAgentSource: String, Equatable, Sendable {
    case claude
    case codex
}

public struct AgentPanelTerminalContext: Equatable, Sendable {
    public let projectPath: String
    public let source: AgentPanelAgentSource
    public let sessionID: String

    public init(projectPath: String, source: AgentPanelAgentSource, sessionID: String) {
        self.projectPath = projectPath
        self.source = source
        self.sessionID = sessionID
    }
}

public enum AgentPanelTerminalIntent: Equatable, Sendable {
    case open(requestID: String, context: AgentPanelTerminalContext)
    case close(requestID: String, context: AgentPanelTerminalContext)
    case contextEnded(requestID: String, context: AgentPanelTerminalContext)
}

public enum AgentPanelRequest: Equatable, Sendable {
    /// One request against the agent-feed sidecar, relayed verbatim.
    ///
    /// This case names no endpoint and no field, which is the point: the sidecar owns the
    /// model and the panel owns the view, and adding a field to either is not a change to
    /// this enum. What travels is a path and, for a POST, an already-serialized body.
    ///
    /// The path is NOT vetted here. `AgentFeedRelay.PathPolicy` is the single allow-list
    /// and the security boundary; a second copy in this decoder would be free to disagree
    /// with the one that actually executes the request.
    case httpRequest(rid: String, method: String, path: String, body: String?, stream: Bool)
    /// Abandons an in-flight relayed request, including a subscription. Replaces every
    /// per-type unwatch the feed used to carry.
    case httpCancel(rid: String)
    case terminal(AgentPanelTerminalIntent)

    public static func decode(tag: String, body: [String: Any]) -> AgentPanelRequest? {
        switch tag {
        case "agent-http-req":
            // Shape only. The body is passed through as the panel serialized it, and the
            // path is checked by the relay, which is the one place that can be right about
            // what a path may address.
            guard let rid = requestIdentifier(body["rid"]),
                  let method = nonemptyString(body["method"]),
                  let path = nonemptyString(body["path"]) else { return nil }
            let requestBody = body["body"] as? String
            return .httpRequest(
                rid: rid,
                method: method,
                path: path,
                body: requestBody,
                stream: body["stream"] as? Bool ?? false
            )
        case "agent-http-cancel":
            guard let rid = requestIdentifier(body["rid"]) else { return nil }
            return .httpCancel(rid: rid)

        case "agent-terminal-open":
            return decodeTerminalIntent(body: body, make: AgentPanelTerminalIntent.open)
        case "agent-terminal-close":
            return decodeTerminalIntent(body: body, make: AgentPanelTerminalIntent.close)
        case "agent-terminal-context-ended":
            return decodeTerminalIntent(body: body, make: AgentPanelTerminalIntent.contextEnded)
        default:
            return nil
        }
    }

    private static func nonemptyString(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty else { return nil }
        return value
    }

    private static func agentSource(_ value: Any?) -> AgentPanelAgentSource? {
        guard let value = nonemptyString(value) else { return nil }
        return AgentPanelAgentSource(rawValue: value)
    }

    private static func requestIdentifier(_ value: Any?) -> String? {
        guard let value = nonemptyString(value) else { return nil }
        return AgentPanelWindowInputBounds.identifier(value)
    }

    /// A session id used to ADDRESS A WINDOW, rather than to name a sidecar transcript.
    ///
    /// A relayed request carries whatever id the sidecar validates for itself. This one is compared
    /// against the live process table to find the window that owns the session, so it is bounded and
    /// charset-restricted here: an unbounded value would be scanned against every process's argv on
    /// every re-resolve.
    private static func sessionIdentifier(_ value: Any?) -> String? {
        requestIdentifier(value)
    }

    private static func decodeTerminalIntent(
        body: [String: Any],
        make: (String, AgentPanelTerminalContext) -> AgentPanelTerminalIntent
    ) -> AgentPanelRequest? {
        guard let requestID = body["rid"] as? String,
              !requestID.isEmpty,
              let rawContext = body["ctx"] as? [String: Any],
              let projectPath = rawContext["pp"] as? String,
              !projectPath.isEmpty,
              let source = agentSource(rawContext["src"]),
              let sessionID = rawContext["sid"] as? String,
              !sessionID.isEmpty else {
            return nil
        }
        return .terminal(make(
            requestID,
            AgentPanelTerminalContext(
                projectPath: projectPath,
                source: source,
                sessionID: sessionID
            )
        ))
    }
}

/// The bounds every identifier must satisfy, wherever it enters the host.
///
/// Public because `AgentPanelRequest.decode` is not the only door: the Mac Agents window posts these
/// requests as webview messages, and the phone posts the same ones over the authenticated QUIC lane
/// as already-decoded wire structs that never touch the decoder above. Both entry points call this,
/// so a bound cannot hold on one surface and be skipped on the other.
///
/// It used to carry composer text and question-option bounds too. Those went with the composer
/// itself (ADR-0110): the sidecar bounds its own request bodies now, and the relay's path policy is
/// what still stands between the page and this process.
public enum AgentPanelWindowInputBounds {
    /// A bounded, charset-restricted identifier, applied to every request and session id that
    /// crosses this door.
    public static func identifier(_ value: String) -> String? {
        guard !value.isEmpty, value.count <= 128,
              value.range(of: #"^[A-Za-z0-9._:-]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }
}

@MainActor
public protocol AgentPanelTransport: AnyObject {
    func sendAgentPanelRequest(_ request: AgentPanelRequest)
}
