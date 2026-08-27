import AgentDeskWire
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

struct AgentWindowSessionResolverTests {
    private let claudeMain = "/Applications/Claude.app/Contents/MacOS/Claude"
    private let flag = "--resume"
    private let desktopSession = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"
    private let terminalSession = "3e1b7a90-55cc-4d10-9f88-2b0c7d6a1e44"

    /// One tree carrying every shape at once, transcribed from a real `ps -axww` reading rather than
    /// invented: a Desktop-owned session reached through Claude.app's `disclaimer` helper and spelling
    /// its id `--resume=<id>`, a terminal session spelling it `--resume <id>`, and a session id that is
    /// a strict prefix of the Desktop one.
    private var fixture: [AgentWindowProcessRow] {
        AgentWindowSessionResolver.parseProcessTable("""
            1     0 /sbin/launchd
          400     1 \(claudeMain)
          410   400 /Applications/Claude.app/Contents/Helpers/disclaimer /Users/dev/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude --output-format stream-json
          420   410 /Users/dev/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude --output-format stream-json --permission-prompt-tool stdio --resume=\(desktopSession)
          500     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
          510   500 -zsh
          520   510 /Users/dev/.local/bin/claude --resume \(terminalSession) --model claude-opus-5
          600     1 \(claudeMain)
          610   600 /Users/dev/.local/bin/claude --resume=\(desktopSession)-archived
        """)
    }

    @Test func processTableParsingSurvivesColumnPaddingAndSpacesInArguments() {
        let rows = fixture

        #expect(rows.count == 9)
        let helper = try? #require(rows.first { $0.pid == 410 })
        #expect(helper?.parentPid == 400)
        // Claude's embedded CLI lives under "Application Support", so the argument tail contains
        // spaces; rejoining after the two numeric columns must not lose them. The `--resume=` marker
        // sits at the very end of a real one of these lines, which is why the live reader passes -ww.
        #expect(helper?.arguments.contains("Application Support/Claude/claude-code") == true)
        #expect(AgentWindowSessionResolver.parseProcessTable("").isEmpty)
        #expect(AgentWindowSessionResolver.parseProcessTable("garbage\n12 notapid args").isEmpty)
    }

    @Test func sessionMatchingIsByWholeTokenSoAPrefixDoesNotStealTheWindow() {
        let rows = fixture

        #expect(AgentWindowSessionResolver.resumePids(sessionId: desktopSession, in: rows, flag: flag) == [420])
        // pid 610 resumes "<desktopSession>-archived". A `contains` match would have returned it here
        // and resolved this session to the wrong Claude window.
        #expect(AgentWindowSessionResolver.resumePids(
            sessionId: "\(desktopSession)-archived",
            in: rows,
            flag: flag
        ) == [610])
        #expect(AgentWindowSessionResolver.resumedSessionIds(
            in: "claude --resume=abc --resume=def",
            flag: flag
        ) == ["abc", "def"])
    }

    @Test func aDesktopChainResolvesToTheClaudeMainProcess() throws {
        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: desktopSession,
            in: fixture,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.claudeMainPid == 400)
        #expect(resolution.unavailableReason == nil)
        let chain = try #require(resolution.chains.first)
        #expect(resolution.chains.count == 1)
        guard case .desktop(let resumePid, let claudeMainPid, let executables) = chain else {
            Issue.record("expected a Desktop chain, got \(chain)")
            return
        }
        #expect(resumePid == 420)
        #expect(claudeMainPid == 400)
        // Three real hops: the embedded CLI, Claude.app's disclaimer helper, Claude.app itself. These
        // strings are a log breadcrumb, not an identity -- the first is truncated at the space in
        // "Application Support", because argv arrives as one flat string with no way to tell an
        // argument boundary from a space in a path. The decision that matters is the last hop's
        // prefix match against the configured Claude main path, which is asserted above as pid 400.
        #expect(executables.count == 3)
        #expect(executables[1] == "/Applications/Claude.app/Contents/Helpers/disclaimer")
        #expect(executables[2] == claudeMain)
    }

    @Test func aSiblingBinaryWhoseNameExtendsTheMainBinaryIsNotMistakenForIt() {
        // ".../MacOS/ClaudeBeta" is a strict prefix extension of the configured main path. A bare
        // `hasPrefix` would stop here and hand back a pid that owns no Claude window.
        let rows = [
            AgentWindowProcessRow(pid: 800, parentPid: 1, arguments: "\(claudeMain)Beta"),
            AgentWindowProcessRow(pid: 810, parentPid: 800, arguments: "/bin/claude --resume=betaish"),
        ]

        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: "betaish",
            in: rows,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.claudeMainPid == nil)
        #expect(resolution.unavailableReason == .terminalOnly)
    }

    @Test func aTerminalChainIsRefusedRatherThanOfferedAWindow() {
        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: terminalSession,
            in: fixture,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.claudeMainPid == nil)
        #expect(resolution.unavailableReason == .terminalOnly)
        #expect(resolution.chains.count == 1)
        #expect(resolution.chains[0].claudeMainPid == nil)
    }

    @Test func anAbsentSessionIsNotRunningRatherThanTerminalOnly() {
        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: "00000000-0000-0000-0000-000000000000",
            in: fixture,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.chains.isEmpty)
        #expect(resolution.unavailableReason == .notRunning)
    }

    // MARK: - Runtime (registry) resolver

    /// A `~/.claude/sessions/<pid>.json` row in the shape Claude Code writes, so tests pin the live
    /// schema rather than a hand-chosen subset.
    private func registryJSON(
        pid: Int,
        sessionId: String,
        entrypoint: String? = "claude-desktop",
        cwd: String = "/Users/dev/projects/agent-desk"
    ) -> String {
        let entrypointJSON = entrypoint.map { "\"entrypoint\":\"\($0)\"" } ?? ""
        let fields = ["\"pid\":\(pid)",
                      "\"sessionId\":\"\(sessionId)\"",
                      "\"cwd\":\"\(cwd)\"",
                      "\"startedAt\":1786078983531",
                      "\"kind\":\"interactive\"",
                      entrypointJSON]
        return "{\(fields.filter { !$0.isEmpty }.joined(separator: ","))}"
    }

    /// A live tree with one Desktop-owned session: the Claude main binary, the `disclaimer` helper,
    /// and the child CLI at `cliPid`. The CLI argv carries no session id on purpose: a brand-new
    /// session never names itself in argv, which is why the registry exists.
    private func desktopChainRows(cliPid: Int, claudeMainPid: Int) -> [AgentWindowProcessRow] {
        AgentWindowSessionResolver.parseProcessTable("""
            1     0 /sbin/launchd
           \(claudeMainPid)     1 \(claudeMain)
           \(cliPid + 1) \(claudeMainPid) /Applications/Claude.app/Contents/Helpers/disclaimer /Users/dev/claude --output-format stream-json
           \(cliPid) \(cliPid + 1) /Users/dev/claude --output-format stream-json --permission-prompt-tool stdio
        """)
    }

    @Test func registryParsingToleratesTheFullObservedSchema() throws {
        // The live file carries pid, sessionId, cwd, startedAt, procStart, version, peerProtocol,
        // kind, entrypoint, name, and nameSource. Decoding must keep what resolution needs and ignore
        // the rest.
        let json = """
        {"pid":90906,"sessionId":"\(desktopSession)","cwd":"/Users/dev/projects/agent-desk",\
        "startedAt":1786078983531,"procStart":"Fri Aug  7 05:03:00 2026","version":"2.1.222",\
        "peerProtocol":1,"kind":"interactive","entrypoint":"claude-desktop","name":"agent-desk-ca",\
        "nameSource":"derived"}
        """
        let data = try #require(json.data(using: .utf8))
        let entry = try JSONDecoder().decode(ClaudeSessionRegistryEntry.self, from: data)
        #expect(entry.pid == 90906)
        #expect(entry.sessionId == desktopSession)
        #expect(entry.entrypoint == "claude-desktop")
        #expect(entry.cwd == "/Users/dev/projects/agent-desk")
    }

    @Test func aNewDesktopSessionIsResolvedFromItsRegistryRow() throws {
        // A brand-new Claude Desktop session (no `--resume`) never carries its feed id in argv. Claude
        // Code's per-pid registry `~/.claude/sessions/<pid>.json` -- written by the child CLI at spawn,
        // before any message or network call -- records that id and the launching surface. Observed
        // live: pid 90906 wrote {"sessionId":"...","entrypoint":"claude-desktop",...}.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try registryJSON(pid: 420, sessionId: desktopSession).write(
            to: root.appendingPathComponent("420.json"),
            atomically: true,
            encoding: .utf8
        )

        let owner = AgentWindowRuntimeResolver.desktopOwner(
            sessionId: desktopSession,
            rows: desktopChainRows(cliPid: 420, claudeMainPid: 400),
            claudeMainPath: claudeMain,
            sessionsDirectory: root.path
        )

        #expect(owner == 400)
    }

    @Test func aStaleRegistryRowWhosePidIsNotInTheLiveTableIsNotLive() throws {
        // Registry rows persist after a session closes (observed live: rows from days ago). A row is
        // live only while its pid's parent chain reaches Claude.app, so a row whose pid is absent from
        // the live table must resolve to nothing, never to a window.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try registryJSON(pid: 420, sessionId: desktopSession).write(
            to: root.appendingPathComponent("420.json"),
            atomically: true,
            encoding: .utf8
        )

        let owner = AgentWindowRuntimeResolver.desktopOwner(
            sessionId: desktopSession,
            rows: [AgentWindowProcessRow(pid: 1, parentPid: 0, arguments: "/sbin/launchd")],
            claudeMainPath: claudeMain,
            sessionsDirectory: root.path
        )

        #expect(owner == nil)
    }

    @Test func aTerminalEntrypointRegistryRowIsNotOfferedAWindow() throws {
        // A terminal Claude Code session also writes a registry row, with entrypoint "cli". It renders
        // into a PTY, not an AX composer, so it must never resolve to a window even when its pid's
        // chain reaches Claude.app.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try registryJSON(pid: 420, sessionId: desktopSession, entrypoint: "cli").write(
            to: root.appendingPathComponent("420.json"),
            atomically: true,
            encoding: .utf8
        )

        let owner = AgentWindowRuntimeResolver.desktopOwner(
            sessionId: desktopSession,
            rows: desktopChainRows(cliPid: 420, claudeMainPid: 400),
            claudeMainPath: claudeMain,
            sessionsDirectory: root.path
        )

        #expect(owner == nil)
    }

    @Test func aRegistryRowForAnotherSessionDoesNotResolveThisOne() throws {
        // A sibling session in the same project has its own id and its own row; this session's row
        // must not make THAT sibling available. The join is per session id, never per project.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try registryJSON(pid: 420, sessionId: terminalSession).write(
            to: root.appendingPathComponent("420.json"),
            atomically: true,
            encoding: .utf8
        )

        let owner = AgentWindowRuntimeResolver.desktopOwner(
            sessionId: desktopSession,
            rows: desktopChainRows(cliPid: 420, claudeMainPid: 400),
            claudeMainPath: claudeMain,
            sessionsDirectory: root.path
        )

        #expect(owner == nil)
    }

    @Test func twoRegistryRowsIntoDifferentInstancesAreAmbiguousRatherThanTiebroken() throws {
        // Two live rows for the SAME session in two Claude instances address two windows; the old
        // lowest-pid tiebreak wrote into whichever launched first, unrelated to the window the user is
        // looking at. Mirror the argv resolver's multiple-instances refusal: only an exactly-one owner
        // resolves.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try registryJSON(pid: 420, sessionId: desktopSession).write(
            to: root.appendingPathComponent("420.json"),
            atomically: true,
            encoding: .utf8
        )
        try registryJSON(pid: 520, sessionId: desktopSession).write(
            to: root.appendingPathComponent("520.json"),
            atomically: true,
            encoding: .utf8
        )
        let rows = desktopChainRows(cliPid: 420, claudeMainPid: 400)
            + desktopChainRows(cliPid: 520, claudeMainPid: 600)

        let owner = AgentWindowRuntimeResolver.desktopOwner(
            sessionId: desktopSession,
            rows: rows,
            claudeMainPath: claudeMain,
            sessionsDirectory: root.path
        )

        #expect(owner == nil)
    }

    @Test func unreadableRegistryFilesAreSkipped() throws {
        // Garbage and non-JSON files in the registry directory must be ignored so one malformed row
        // cannot poison resolution of a healthy one.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try registryJSON(pid: 420, sessionId: desktopSession).write(
            to: root.appendingPathComponent("420.json"),
            atomically: true,
            encoding: .utf8
        )
        try "not json".write(to: root.appendingPathComponent("999.json"), atomically: true, encoding: .utf8)
        try "also not json".write(to: root.appendingPathComponent("README.txt"), atomically: true, encoding: .utf8)

        let entries = AgentWindowRuntimeResolver.registryEntries(in: root.path)
        #expect(entries.map(\.pid).sorted() == [420])

        let owner = AgentWindowRuntimeResolver.desktopOwner(
            sessionId: desktopSession,
            rows: desktopChainRows(cliPid: 420, claudeMainPid: 400),
            claudeMainPath: claudeMain,
            sessionsDirectory: root.path
        )
        #expect(owner == 400)
    }

    @Test func theDesktopChainWinsWhenTheSameSessionIsAlsoResumedInATerminal() {
        var rows = fixture
        rows.append(AgentWindowProcessRow(
            pid: 530,
            parentPid: 510,
            arguments: "/Users/dev/.local/bin/claude --resume=\(desktopSession)"
        ))

        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: desktopSession,
            in: rows,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.chains.count == 2)
        #expect(resolution.claudeMainPid == 400)
        #expect(resolution.unavailableReason == nil)
    }

    @Test func twoClaudeInstancesHoldingOneSessionIsReportedRatherThanTiebroken() {
        // Observed live: restarting Claude Desktop left two instances running, and both restored the
        // same session, each into its own window on its own Desktop. The old lowest-pid tiebreak
        // resolved to the instance that launched first and wrote into the wrong Desktop's composer.
        var rows = fixture
        rows.append(AgentWindowProcessRow(
            pid: 620,
            parentPid: 600,
            arguments: "/Applications/Claude.app/Contents/Helpers/disclaimer /Users/dev/claude"
        ))
        rows.append(AgentWindowProcessRow(
            pid: 630,
            parentPid: 620,
            arguments: "/Users/dev/claude --output-format stream-json --resume=\(desktopSession)"
        ))

        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: desktopSession,
            in: rows,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.claudeMainPids == [400, 600])
        #expect(resolution.claudeMainPid == nil)
        #expect(resolution.unavailableReason == .multipleInstances)
    }

    @Test func severalChainsIntoOneInstanceStillResolveToThatInstance() {
        // Distinct pids, not chain count, is what makes a session ambiguous. One instance can produce
        // several chains -- a respawned child, or the terminal resume above -- and they all address
        // the same window, so this must stay writable.
        var rows = fixture
        rows.append(AgentWindowProcessRow(
            pid: 430,
            parentPid: 410,
            arguments: "/Users/dev/claude --output-format stream-json --resume=\(desktopSession)"
        ))

        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: desktopSession,
            in: rows,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.chains.count == 2)
        #expect(resolution.claudeMainPids == [400])
        #expect(resolution.claudeMainPid == 400)
        #expect(resolution.unavailableReason == nil)
    }

    @Test func aCyclicParentChainTerminatesInsteadOfSpinning() {
        let rows = [
            AgentWindowProcessRow(pid: 700, parentPid: 701, arguments: "/bin/claude --resume=cyclic"),
            AgentWindowProcessRow(pid: 701, parentPid: 700, arguments: "/bin/loop"),
        ]

        let resolution = AgentWindowSessionResolver.resolve(
            sessionId: "cyclic",
            in: rows,
            claudeMainPath: claudeMain,
            flag: flag
        )

        #expect(resolution.unavailableReason == .terminalOnly)
    }

    // MARK: - Window targeting

    private func snapshot(
        activeSpaceID: UInt64?,
        windows: [WorkspaceDesktopWindow],
        diagnostic: String? = nil
    ) -> WorkspaceDesktopSnapshot {
        WorkspaceDesktopSnapshot(
            activeSpaceID: activeSpaceID,
            desktops: [],
            windows: windows,
            diagnostic: diagnostic
        )
    }

    private func window(
        id: UInt32,
        pid: pid_t,
        spaceIDs: [UInt64],
        layer: Int = 0,
        title: String = "Claude"
    ) -> WorkspaceDesktopWindow {
        WorkspaceDesktopWindow(
            windowID: id,
            ownerPID: pid,
            ownerName: "Claude",
            title: title,
            spaceIDs: spaceIDs,
            layer: layer,
            bounds: CGRect(x: 0, y: 0, width: 1200, height: 800),
            expectation: .otherApp
        )
    }

    @Test func targetingReportsTheWindowsHomeDesktopAndWhetherItIsAlreadyActive() {
        let offActive = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [window(id: 42, pid: 400, spaceIDs: [4])])
        )

        #expect(offActive == .success(AgentWindowSessionTarget(
            sessionId: desktopSession,
            claudeMainPid: 400,
            windowID: 42,
            homeSpaceID: 4,
            activeSpaceID: 1,
            frame: CGRect(x: 0, y: 0, width: 1200, height: 800)
        )))
        #expect((try? offActive.get())?.isOnActiveDesktop == false)

        let onActive = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [window(id: 42, pid: 400, spaceIDs: [1])])
        )
        #expect((try? onActive.get())?.isOnActiveDesktop == true)
    }

    @Test func targetingPrefersTheWindowAlreadyOnTheActiveDesktop() {
        let result = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [
                window(id: 42, pid: 400, spaceIDs: [4]),
                window(id: 43, pid: 400, spaceIDs: [1]),
            ])
        )

        // Picking the free one avoids moving a window when this process already has one in reach.
        #expect((try? result.get())?.windowID == 43)
    }

    @Test func targetingSkipsTheUntitledScaffoldingWindowsElectronAlsoOwns() {
        // Measured against the live app: one Claude Desktop instance owned eight layer-0 windows, of
        // which seven were untitled Electron scaffolding (1800x39 strips, 800x600 and 500x500 shells)
        // and one was the real browser window. Scaffolding sorts first by window id, so taking the
        // lowest id on the active Space used to select a strip -- which then reads as "already on the
        // active Desktop", skips the move, and leaves the real window's tree collapsed on its own
        // Space. The failure surfaced as a missing composer.
        let result = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [
                window(id: 10, pid: 400, spaceIDs: [1], title: ""),
                window(id: 11, pid: 400, spaceIDs: [1], title: ""),
                window(id: 12, pid: 400, spaceIDs: [4]),
            ])
        )

        // The real window, on its own Desktop, so the caller moves it in rather than believing a strip.
        #expect((try? result.get())?.windowID == 12)
        #expect((try? result.get())?.isOnActiveDesktop == false)

        let onlyScaffolding = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [window(id: 10, pid: 400, spaceIDs: [1], title: "")])
        )
        #expect(onlyScaffolding == .failure(.noWindow))
    }

    @Test func targetingRefusesWindowsThatAreNotOrdinaryOrNotOnOneDesktop() {
        // Another app's window, a non-zero layer panel, and an all-Spaces window are all excluded.
        let foreign = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [window(id: 42, pid: 999, spaceIDs: [1])])
        )
        #expect(foreign == .failure(.noWindow))

        let panel = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [window(id: 42, pid: 400, spaceIDs: [1], layer: 3)])
        )
        #expect(panel == .failure(.noWindow))

        let allSpaces = AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: 1, windows: [window(id: 42, pid: 400, spaceIDs: [1, 2])])
        )
        #expect(allSpaces == .failure(.noWindow))
    }

    @Test func anUnavailableSpaceAuthorityFailsLoudRatherThanGuessingADesktop() {
        #expect(AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(activeSpaceID: nil, windows: [window(id: 42, pid: 400, spaceIDs: [4])])
        ) == .failure(.placementUnavailable))

        #expect(AgentWindowSessionTargeting.target(
            sessionId: desktopSession,
            claudeMainPid: 400,
            in: snapshot(
                activeSpaceID: 1,
                windows: [window(id: 42, pid: 400, spaceIDs: [4])],
                diagnostic: "SkyLight symbols unavailable"
            )
        ) == .failure(.placementUnavailable))
    }
}
