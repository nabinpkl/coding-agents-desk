import Foundation
import Testing

@testable import AgentDeskHost

// Which program the host starts for the sidecar: the compiled binary it shipped with, or the
// source tree under `bun --watch`.
//
// Every fallback here is tested because every one of them is silent by nature. A dev launch that
// asks for the live sidecar and quietly gets the frozen one looks identical to an edit that did
// nothing, and that is precisely the confusion the live arm exists to remove.
@Suite
struct AgentFeedSidecarLaunchTests {
    private let bundled = URL(fileURLWithPath: "/Applications/AgentDesk.app/agent-feed-sidecar")

    /// A real readable file, because the selection checks the filesystem rather than trusting the
    /// string it was handed.
    private func temporaryFile(executable: Bool) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-feed-launch-\(UUID().uuidString)")
        try Data("x".utf8).write(to: url)
        try FileManager.default.setAttributes(
            [.posixPermissions: executable ? 0o755 : 0o644],
            ofItemAtPath: url.path
        )
        return url
    }

    @Test func noEnvironmentRunsTheBundledBinary() {
        let launch = Config.agentFeedSidecarLaunch(from: [:], bundled: bundled)
        #expect(launch?.executable == bundled)
        #expect(launch?.arguments.isEmpty == true)
        #expect(launch?.reloadsOnEdit == false)
    }

    @Test func anEntryAndABunRunTheSourceUnderWatch() throws {
        let entry = try temporaryFile(executable: false)
        let bun = try temporaryFile(executable: true)
        defer {
            try? FileManager.default.removeItem(at: entry)
            try? FileManager.default.removeItem(at: bun)
        }

        let launch = Config.agentFeedSidecarLaunch(
            from: [
                "AGENTDESK_AGENT_FEED_SIDECAR_ENTRY": entry.path,
                "AGENTDESK_BUN_PATH": bun.path,
            ],
            bundled: bundled
        )
        #expect(launch?.executable.path == bun.path)
        // `--watch` and not `--hot`: watch re-reads the source in process and rebinds the port,
        // where hot replacement would leave the catalog and the live observers half-swapped.
        #expect(launch?.arguments == ["--watch", entry.path])
        #expect(launch?.reloadsOnEdit == true)
    }

    @Test func anEntryWithoutABunFallsBackAndSaysSo() throws {
        let entry = try temporaryFile(executable: false)
        defer { try? FileManager.default.removeItem(at: entry) }

        var said: [String] = []
        let launch = Config.agentFeedSidecarLaunch(
            from: ["AGENTDESK_AGENT_FEED_SIDECAR_ENTRY": entry.path],
            bundled: bundled
        ) { said.append($0) }
        #expect(launch?.executable == bundled)
        #expect(said.count == 1)
    }

    @Test func anEntryThatIsNotThereFallsBackAndSaysSo() throws {
        let bun = try temporaryFile(executable: true)
        defer { try? FileManager.default.removeItem(at: bun) }

        var said: [String] = []
        let launch = Config.agentFeedSidecarLaunch(
            from: [
                "AGENTDESK_AGENT_FEED_SIDECAR_ENTRY": "/nonexistent/agent-desk/server.ts",
                "AGENTDESK_BUN_PATH": bun.path,
            ],
            bundled: bundled
        ) { said.append($0) }
        #expect(launch?.executable == bundled)
        #expect(said.count == 1)
    }

    @Test func aBunThatCannotBeExecutedFallsBackAndSaysSo() throws {
        let entry = try temporaryFile(executable: false)
        let bun = try temporaryFile(executable: false)
        defer {
            try? FileManager.default.removeItem(at: entry)
            try? FileManager.default.removeItem(at: bun)
        }

        var said: [String] = []
        let launch = Config.agentFeedSidecarLaunch(
            from: [
                "AGENTDESK_AGENT_FEED_SIDECAR_ENTRY": entry.path,
                "AGENTDESK_BUN_PATH": bun.path,
            ],
            bundled: bundled
        ) { said.append($0) }
        #expect(launch?.executable == bundled)
        #expect(said.count == 1)
    }

    @Test func anEmptyValueIsTreatedAsUnset() {
        // A shell exports an empty string when a substitution produced nothing, and an empty entry
        // must not read as "run the source tree from the filesystem root".
        let launch = Config.agentFeedSidecarLaunch(
            from: ["AGENTDESK_AGENT_FEED_SIDECAR_ENTRY": "  ", "AGENTDESK_BUN_PATH": "  "],
            bundled: bundled
        )
        #expect(launch?.executable == bundled)
        #expect(launch?.reloadsOnEdit == false)
    }

    @Test func noBundledBinaryAndNoSourceIsNoLaunchAtAll() {
        #expect(Config.agentFeedSidecarLaunch(from: [:], bundled: nil) == nil)
    }
}
