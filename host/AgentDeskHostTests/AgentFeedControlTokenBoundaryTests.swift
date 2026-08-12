import Foundation
import Testing

@testable import AgentDeskHost

/// The agent-feed control token is a capability, and its whole value is who cannot read it.
///
/// Normally the host mints it per sidecar spawn and it exists only in the host's memory and the
/// sidecar's own environment, which the sidecar then deletes so the agents it spawns cannot see it.
/// A dev launch may instead hand the host a token minted by the panel's Vite dev server, so a plain
/// browser tab can reach the sidecar through that server's proxy (ADR-0096). That puts the token in
/// the HOST's environment, where `Process` passes it to children by default -- including the PTY
/// runtime, whose descendants are terminal shells running agents with bash tools.
///
/// So these are the two halves of the same rule: everything gets the environment without it, and
/// the sidecar gets it back explicitly.
struct AgentFeedControlTokenBoundaryTests {

    @Test func childEnvironmentDropsTheCapability() {
        let sanitized = Config.childProcessEnvironment(from: [
            Config.agentFeedControlTokenVariable: "capability",
            "PATH": "/usr/bin",
            "HOME": "/Users/someone",
        ])
        #expect(sanitized[Config.agentFeedControlTokenVariable] == nil)
        // Stripping one key, not replacing the environment: a child with no PATH or HOME is a
        // different bug, and the reason every spawn here merges over an inherited env.
        #expect(sanitized["PATH"] == "/usr/bin")
        #expect(sanitized["HOME"] == "/Users/someone")
    }

    @Test func childEnvironmentIsUnchangedWithoutTheCapability() {
        let original = ["PATH": "/usr/bin", "TERM": "xterm"]
        #expect(Config.childProcessEnvironment(from: original) == original)
    }

    @Test func theHostAdoptsOnlyANonEmptyToken() {
        // The override is read from the real environment, so this asserts the shape of the answer
        // rather than a value: a host that is not mid-dev-launch has no token to adopt and must
        // fall back to minting, and a blank one must read as absent rather than as a token of "".
        let adopted = Config.agentFeedSidecarControlTokenOverride
        #expect(adopted == nil || !(adopted ?? "").isEmpty)
    }
}
