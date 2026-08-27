import Foundation

// What still lives here after the agent-feed payloads left.
//
// The feed's model used to be restated in this file in abbreviated keys, renamed into and out of a
// second Swift restatement of the same shapes, and mirrored again in TypeScript on both ends. The
// sidecar owns that model now and it travels as an opaque body through `AgentFeedRelayFrames`, so
// there is nothing here to keep in step with it.
//
// What remains is native authority: the Claude Desktop composer sync and the AskUserQuestion mirror
// write into another application's window through Accessibility, and `SessionRevoke` ends a session.
// Those are bounded, typed, and rarely changed on purpose -- editing them SHOULD cost a Swift
// compile, because each one is a capability rather than a view of data the sidecar already owns.

public struct SessionRevoke: Codable, Equatable, Sendable {
    public let type = "revoke"
    public enum CodingKeys: String, CodingKey { case type = "t" }
    public init() {}
}

// MARK: - Window placement failures

/// Why moving a window between Desktops did not happen.
///
/// What is left of a much larger set. The composer's failure codes moved to
/// `agent-feed/wire/desktopWindow.ts` with the composer itself (ADR-0110), where the sidecar and the
/// standalone helper both read them. These two stayed because `BridgedWindowSpaceMover` is host-owned
/// window placement and throws them.
public enum AgentWindowInputReason: String, Error, Equatable, Sendable {
    case moveFailed = "move-failed"
    /// The current macOS build does not expose the private bridged operation for moving another
    /// application's window between Desktops. Separate from `moveFailed` because retrying cannot
    /// restore an unavailable native capability.
    case windowMoverUnavailable = "window-mover-unavailable"
}
