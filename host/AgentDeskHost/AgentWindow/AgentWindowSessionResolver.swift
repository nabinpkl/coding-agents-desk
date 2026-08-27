import AgentDeskWire
import Foundation

/// One row of the live process table, reduced to what session resolution needs.
struct AgentWindowProcessRow: Equatable, Sendable {
    let pid: pid_t
    let parentPid: pid_t
    let arguments: String
}

/// How one `--resume=<sessionId>` process relates to a Claude Desktop window.
///
/// The same session id can legitimately appear more than once: a human can resume the same transcript
/// in a terminal while its Desktop window is also open. Each resuming process is classified on its own
/// chain, and a Desktop match beats a terminal one, because only a window has a composer to write into.
/// Two Desktop matches in DIFFERENT instances beat nothing -- see `claudeMainPids`.
enum AgentWindowSessionChain: Equatable, Sendable {
    /// The parent chain reached the Claude.app main binary. That pid owns the session's window.
    case desktop(resumePid: pid_t, claudeMainPid: pid_t, executables: [String])
    /// The chain terminated at a shell, tmux, launchd, or an unreadable parent. A terminal session
    /// renders into a PTY, not an AX text area, so it has nothing to sync with.
    case terminal(resumePid: pid_t, executables: [String])

    var claudeMainPid: pid_t? {
        if case .desktop(_, let claudeMainPid, _) = self { return claudeMainPid }
        return nil
    }
}

/// Everything the process tree can say about one session id, before windows are consulted.
struct AgentWindowSessionResolution: Equatable, Sendable {
    let sessionId: String
    let chains: [AgentWindowSessionChain]

    /// Every DISTINCT Claude Desktop process holding this session, ascending.
    ///
    /// Distinct, because one instance legitimately produces several chains for one session -- a
    /// terminal resume alongside the Desktop one, or a respawned child -- and those all address the
    /// same window. More than one pid is the different case: separate app instances, separate
    /// windows, separate Desktops.
    var claudeMainPids: [pid_t] {
        Array(Set(chains.compactMap(\.claudeMainPid))).sorted()
    }

    /// The Claude Desktop process owning this session, or nil unless exactly one owns it.
    ///
    /// Deliberately nil rather than a pick when several instances hold the session. The previous
    /// lowest-pid tiebreak was stable but silent: it resolved to whichever instance launched first,
    /// which is unrelated to the window the user is looking at, and a write to the wrong instance is
    /// indistinguishable from a correct one until the text lands in another Desktop's session.
    var claudeMainPid: pid_t? {
        let pids = claudeMainPids
        return pids.count == 1 ? pids[0] : nil
    }

    /// Why no window can be addressed, or nil when exactly one can. The cases are worth
    /// distinguishing in the panel: "not running" is fixed by opening the session, "terminal only"
    /// never will be, and "multiple instances" is fixed by closing the session in one of them.
    var unavailableReason: AgentWindowInputReason? {
        switch claudeMainPids.count {
        case 1: return nil
        case 0: return chains.isEmpty ? .notRunning : .terminalOnly
        default: return .multipleInstances
        }
    }
}

/// Resolves a Claude session id to the Claude Desktop process that owns its window.
///
/// The mapping is the process tree, not content or window titles. Claude Desktop runs a RESUMED coding
/// session as a child Claude Code CLI whose argv carries `--resume=<sessionId>`, the same id that names
/// the session's transcript file, so walking that child's parents to the Claude.app main binary
/// identifies the owning window process exactly. A brand-new (not resumed) session never carries its id
/// in argv; it is resolved separately by `AgentWindowRuntimeResolver` from Claude Code's per-pid
/// registry. The AX tree exposes no session id, URL, or document identity, so there is no second
/// window-based source and none is attempted.
///
/// Parsing and classification are pure and take the process table as a value, so every case -- Desktop
/// child, terminal-only chain, absent session, prefix collision -- is testable against fixture `ps`
/// output without a live process tree.
enum AgentWindowSessionResolver {
    /// Longest parent chain walked before giving up. Real chains are three or four deep; the bound
    /// exists so a cycle in a malformed table cannot spin.
    static let maxChainDepth = 16

    static func parseProcessTable(_ text: String) -> [AgentWindowProcessRow] {
        text.split(separator: "\n").compactMap { line in
            let fields = line.split(separator: " ", omittingEmptySubsequences: true)
            guard fields.count >= 3,
                  let pid = pid_t(fields[0]),
                  let parentPid = pid_t(fields[1]) else { return nil }
            // Rejoining rather than slicing the original line keeps this independent of how many
            // spaces `ps` used to pad its numeric columns.
            let arguments = fields.dropFirst(2).joined(separator: " ")
            guard !arguments.isEmpty else { return nil }
            return AgentWindowProcessRow(pid: pid, parentPid: parentPid, arguments: arguments)
        }
    }

    /// Every process resuming exactly this session, lowest pid first.
    static func resumePids(
        sessionId: String,
        in rows: [AgentWindowProcessRow],
        flag: String = Config.claudeResumeFlag
    ) -> [pid_t] {
        rows
            .filter { resumedSessionIds(in: $0.arguments, flag: flag).contains(sessionId) }
            .map(\.pid)
            .sorted()
    }

    /// Every session id this process resumes, in both live argv spellings.
    ///
    /// `--resume=<id>` is what Claude Desktop's embedded CLI passes; `--resume <id>` is what a terminal
    /// session passes. Both are read here so a terminal session is FOUND and then classified as
    /// terminal, rather than going unseen and reporting as not running.
    ///
    /// Ids are taken as whole tokens, never by `contains(flag + sessionId)`. A containment test makes
    /// any session id that is a prefix of another resolve to the wrong window, and session ids are
    /// opaque, so nothing downstream would catch it.
    static func resumedSessionIds(in arguments: String, flag: String) -> Set<String> {
        guard !flag.isEmpty else { return [] }
        let tokens = arguments.split(separator: " ", omittingEmptySubsequences: true)
        var found: Set<String> = []
        for (index, token) in tokens.enumerated() {
            if token == flag {
                // `--resume <id>`: the value is the next token, unless the flag ends the line.
                if index + 1 < tokens.count { found.insert(String(tokens[index + 1])) }
            } else if token.hasPrefix(flag + "=") {
                // `--resume=<id>`.
                let value = token.dropFirst(flag.count + 1)
                if !value.isEmpty { found.insert(String(value)) }
            }
        }
        return found
    }

    static func chain(
        resumePid: pid_t,
        in rows: [AgentWindowProcessRow],
        claudeMainPath: String = Config.claudeDesktopMainPath
    ) -> AgentWindowSessionChain {
        let byPid = Dictionary(rows.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        var executables: [String] = []
        var current = resumePid
        var visited: Set<pid_t> = []
        for _ in 0..<maxChainDepth {
            guard visited.insert(current).inserted, let row = byPid[current] else { break }
            executables.append(row.arguments.split(separator: " ").first.map(String.init) ?? "?")
            // Whole-token match rather than a bare prefix, so a sibling binary like `.../MacOS/ClaudeX`
            // is not read as the main process. This cannot disambiguate a path that legitimately
            // contains a space from an argument boundary -- argv arrives as one flat string -- but
            // Claude's helpers live under `Contents/Frameworks/`, and a wrong pid here degrades to
            // `.noWindow` at targeting rather than to a write against the wrong window.
            if row.arguments == claudeMainPath || row.arguments.hasPrefix(claudeMainPath + " ") {
                return .desktop(resumePid: resumePid, claudeMainPid: current, executables: executables)
            }
            if row.parentPid <= 1 { break }
            current = row.parentPid
        }
        return .terminal(resumePid: resumePid, executables: executables)
    }

    static func resolve(
        sessionId: String,
        in rows: [AgentWindowProcessRow],
        claudeMainPath: String = Config.claudeDesktopMainPath,
        flag: String = Config.claudeResumeFlag
    ) -> AgentWindowSessionResolution {
        let chains = resumePids(sessionId: sessionId, in: rows, flag: flag)
            .map { chain(resumePid: $0, in: rows, claudeMainPath: claudeMainPath) }
        return AgentWindowSessionResolution(sessionId: sessionId, chains: chains)
    }

    /// Reads the live process table.
    ///
    /// `-ww` is load-bearing: without it `ps` truncates argv at the terminal width, and the
    /// `--resume=<sessionId>` marker sits at the end of a long Claude Code command line, so a truncated
    /// row silently reads as "session not running".
    static func liveProcessRows() -> [AgentWindowProcessRow] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axww", "-o", "pid=,ppid=,args="]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = Pipe()
        guard (try? process.run()) != nil else { return [] }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0, let text = String(data: data, encoding: .utf8) else {
            return []
        }
        return parseProcessTable(text)
    }
}

/// A Claude Desktop window that owns a session, located on the Desktop it currently sits on.
struct AgentWindowSessionTarget: Equatable, Sendable {
    let sessionId: String
    let claudeMainPid: pid_t
    let windowID: UInt32
    let homeSpaceID: UInt64
    let activeSpaceID: UInt64
    /// WindowServer's bounds for this window. Carried because the Accessibility API has no notion of a
    /// `CGWindowID`: correlating the audited window to its `AXUIElement` is a frame match against the
    /// same process's AX windows.
    let frame: CGRect

    var isOnActiveDesktop: Bool { homeSpaceID == activeSpaceID }
}

/// One decoded row of Claude Code's per-pid session registry, `~/.claude/sessions/<pid>.json`.
///
/// The child CLI writes one file per running session, keyed by the CLI's real pid, at session spawn
/// and before any message is sent. `sessionId` is the SAME id that names the feed session and its
/// transcript file, and `entrypoint` names the launching surface (`claude-desktop` for a Desktop
/// window, `cli` for a terminal). Fields resolution does not need are ignored.
struct ClaudeSessionRegistryEntry: Codable, Equatable, Sendable {
    let pid: Int
    let sessionId: String
    let cwd: String?
    let entrypoint: String?
}

/// Runtime (filesystem-backed) fallback for sessions the pure argv resolver cannot name.
///
/// A brand-new Claude Code session — created inside Claude Desktop, not resumed — never puts its id
/// in a child argv, so `AgentWindowSessionResolver` returns `.notRunning` for a window that is
/// plainly open. Claude Code keeps a per-pid registry at `~/.claude/sessions/<pid>.json` written by
/// that child at spawn, so the join is per session — this session's registry row, this holder —
/// never per project, and it needs neither network traffic nor the transcript being open or written.
/// A row is live only while its pid's parent chain reaches Claude.app, so a stale row left behind by
/// a closed session never resolves to a window, and a different session in the same project never
/// matches because it has its own id and its own row.
enum AgentWindowRuntimeResolver {
    /// Every readable registry row under `sessionsDirectory`. Malformed or non-JSON files are
    /// skipped so one bad row cannot poison resolution of the healthy ones.
    static func registryEntries(in sessionsDirectory: String) -> [ClaudeSessionRegistryEntry] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: sessionsDirectory) else {
            return []
        }
        return names
            .filter { $0.hasSuffix(".json") }
            .compactMap { name in
                guard let data = try? Data(contentsOf: URL(fileURLWithPath: sessionsDirectory + "/" + name))
                else { return nil }
                return try? JSONDecoder().decode(ClaudeSessionRegistryEntry.self, from: data)
            }
    }

    /// The Claude Desktop window owning a NEW session, found per session: the registry row holding
    /// THIS session's id, launched as a Desktop coding session, whose pid's parent chain reaches
    /// Claude.app. Returns the Claude main pid, or nil when no row matches, the row's process is no
    /// longer live, or more than one instance owns the session.
    static func desktopOwner(
        sessionId: String,
        rows: [AgentWindowProcessRow],
        claudeMainPath: String,
        sessionsDirectory: String = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/sessions").path,
        entrypoint: String = Config.claudeDesktopRegistryEntrypoint
    ) -> pid_t? {
        var owners: [pid_t] = []
        for entry in registryEntries(in: sessionsDirectory) where entry.sessionId == sessionId {
            guard entry.entrypoint == entrypoint else { continue }
            guard case .desktop(_, let claudeMainPid, _) =
                AgentWindowSessionResolver.chain(
                    resumePid: pid_t(entry.pid),
                    in: rows,
                    claudeMainPath: claudeMainPath
                )
            else { continue }
            if !owners.contains(claudeMainPid) { owners.append(claudeMainPid) }
        }
        return owners.count == 1 ? owners[0] : nil
    }
}

/// Turns a resolved Claude pid into the window and Desktop the composer writer needs.
///
/// Windows come from the shared desktop audit rather than a CGWindowList of this feature's own: the
/// audit already lists off-Space windows with their Space membership, and a second window source is
/// exactly the divergence ADR-0092 consolidated away.
enum AgentWindowSessionTargeting {
    static func target(
        sessionId: String,
        claudeMainPid: pid_t,
        in snapshot: WorkspaceDesktopSnapshot
    ) -> Result<AgentWindowSessionTarget, AgentWindowInputReason> {
        guard let activeSpaceID = snapshot.activeSpaceID, snapshot.diagnostic == nil else {
            return .failure(.placementUnavailable)
        }
        // Ordinary app windows only. Layer 0 excludes panels, sheets, and the status-item and shadow
        // entries CGWindowList also reports for the same process, none of which hold the composer.
        //
        // Layer 0 alone is NOT enough, which cost a long diagnosis: one Claude Desktop instance was
        // measured owning eight layer-0 windows -- four 1800x39 strips, two 800x600, one 500x500, and
        // the real 644x795 browser window. Only the last carries a title; Electron's scaffolding
        // windows are all untitled. Without this filter the lowest-windowID scaffolding window on the
        // active Space wins the selection below, the target then reads as already-on-the-active-Desktop,
        // so no move happens, and the REAL window keeps the collapsed accessibility tree Chromium gives
        // a window on another Space. That surfaces as "composer missing" with nothing pointing at the
        // window it actually looked in.
        let candidates = snapshot.windows
            .filter { $0.ownerPID == claudeMainPid && $0.layer == 0 }
            .filter { !$0.title.isEmpty }
            .filter { $0.spaceIDs.count == 1 }
            .sorted { $0.windowID < $1.windowID }
        guard let window = candidates.first(where: { $0.spaceID == activeSpaceID }) ?? candidates.first,
              let homeSpaceID = window.spaceID else {
            return .failure(.noWindow)
        }
        return .success(AgentWindowSessionTarget(
            sessionId: sessionId,
            claudeMainPid: claudeMainPid,
            windowID: window.windowID,
            homeSpaceID: homeSpaceID,
            activeSpaceID: activeSpaceID,
            frame: window.bounds
        ))
    }
}
