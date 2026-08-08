import AgentDeskWire
import AppKit
import Foundation

/// One row of Codex Desktop's own thread registry, reduced to what resolution needs.
///
/// `state_5.sqlite` `threads` is the desktop app's registry: `id` is the SAME thread id the feed keys
/// codex sessions by, `cwd` is the project directory, `title` is the (lowercased) thread title, and
/// `first_user_message` is the first prompt the thread received. Fields resolution does not need are
/// ignored.
struct CodexThreadRecord: Equatable, Sendable {
    let threadId: String
    let title: String
    let cwd: String
    let firstUserMessage: String
}

/// One line of `~/.codex/session_index.jsonl`, the app's display-title index.
///
/// `thread_name` is the title the app SHOWS in the window header -- it matches the accessibility header
/// button text exactly, where `threads.title` is lowercased and does not.
struct CodexSessionIndexEntry: Equatable, Sendable {
    let threadId: String
    let threadName: String
}

/// The identity a Codex Desktop window's accessibility tree exposes for the thread it is showing.
///
/// Ground-truthed against the live app: each window's header holds a `AXPopUpButton` whose description
/// reads `Project: <directory name>` and a title button carrying the thread's display title; the first
/// user message appears as a `You said:` static text followed by the message. `frame` is what correlates
/// the window to its audited `CGWindowID` for a Space move.
struct CodexWindowSummary: Equatable, Sendable {
    let threadTitle: String
    let projectName: String
    let firstUserMessage: String?
    let frame: CGRect
}

/// How one thread id maps onto the open Codex Desktop windows.
enum CodexWindowMatch: Equatable, Sendable {
    /// Exactly one window shows this thread.
    case matched(CodexWindowSummary)
    /// More than one window matches. Refused rather than guessed: the write would land in the wrong
    /// conversation and look successful until the text appears there.
    case ambiguous([CodexWindowSummary])
    /// No open window shows this thread.
    case notFound
}

/// Resolves a Codex Desktop thread id to the window showing it.
///
/// The mapping is the app's own state joined to the accessibility header, never the process tree:
/// Codex Desktop runs ONE `codex app-server` child for every thread of every window, and no child argv
/// or registry file carries the thread id in a window-distinguishing way (probed live). The thread's
/// `thread_name` and `cwd` come from `~/.codex` state files; each window's accessibility header exposes
/// the thread title button and the `Project: <name>` popup. Matching is layered so a thread that has
/// not received its first message yet -- whose title is still the generic `New chat` and whose
/// `first_user_message` is empty -- still resolves when its project is unique among open windows, and
/// otherwise refuses with `.ambiguousWindow` instead of guessing.
///
/// Parsing and matching are pure and take file text and window summaries as values, so every case is
/// testable against fixtures without a live app or process table.
enum CodexWindowSessionResolver {
    /// Titles Codex Desktop gives a thread that has not been named yet. A thread is auto-titled from
    /// its first message, so these are transient, but while they last they cannot disambiguate two
    /// windows of the same project.
    static let genericTitles: Set<String> = ["new chat", "new voice chat", "untitled", ""]

    /// Parses `threads` rows out of the `sqlite3 -json` query the live reader runs. Malformed or
    /// foreign rows are skipped so one bad row cannot poison resolution of the healthy ones.
    static func parseThreadsRows(_ json: Data) -> [CodexThreadRecord] {
        struct Row: Decodable {
            let id: String
            let title: String?
            let cwd: String?
            let first_user_message: String?
        }
        guard let rows = try? JSONDecoder().decode([Row].self, from: json) else { return [] }
        return rows.compactMap { row in
            guard let cwd = row.cwd, !cwd.isEmpty else { return nil }
            return CodexThreadRecord(
                threadId: row.id,
                title: row.title ?? "",
                cwd: cwd,
                firstUserMessage: row.first_user_message ?? ""
            )
        }
    }

    /// Parses `session_index.jsonl` lines. The file is a strict JSONL of `{"id", "thread_name",
    /// "updated_at"}`; lines that do not decode are skipped.
    static func parseSessionIndex(_ text: String) -> [CodexSessionIndexEntry] {
        struct Line: Decodable {
            let id: String
            let thread_name: String?
        }
        return text
            .split(separator: "\n")
            .compactMap { line in
                guard let data = line.data(using: .utf8),
                      let entry = try? JSONDecoder().decode(Line.self, from: data),
                      let name = entry.thread_name, !name.isEmpty
                else { return nil }
                return CodexSessionIndexEntry(threadId: entry.id, threadName: name)
            }
    }

    /// The directory name the `Project: <name>` popup shows for a thread's working directory.
    static func projectName(for cwd: String) -> String {
        (cwd as NSString).lastPathComponent
    }

    /// Resolves one thread to the unique window showing it, per the layered rules:
    ///
    /// - A named thread must match BOTH the header title button (against the display `thread_name`,
    ///   then the lowercased `threads.title`) and the `Project:` popup (against the thread's `cwd`
    ///   directory name).
    /// - A still-generic thread (`New chat` / `New voice chat` / `Untitled` / empty) drops the title
    ///   requirement: the project popup alone is identity, and only a unique project match counts.
    /// - When neither anchor resolves, the thread's first user message is matched against each
    ///   window's first `You said:` text, still constrained by the project.
    /// - More than one candidate at any stage is `.ambiguous`; none is `.notFound`.
    static func resolve(
        threadId: String,
        title: String,
        cwd: String,
        firstUserMessage: String,
        threadName: String,
        windows: [CodexWindowSummary]
    ) -> CodexWindowMatch {
        let project = projectName(for: cwd)
        let displayName = threadName.isEmpty ? title : threadName
        let isGeneric = genericTitles.contains(displayName.lowercased())

        var candidates = windows.filter { window in
            guard !project.isEmpty else { return false }
            guard window.projectName == project else { return false }
            if isGeneric { return true }
            let titleMatches = (!threadName.isEmpty && window.threadTitle == threadName)
                || (!title.isEmpty && window.threadTitle.lowercased() == title.lowercased())
            return titleMatches
        }

        if candidates.isEmpty, !firstUserMessage.isEmpty {
            candidates = windows.filter { window in
                window.projectName == project && window.firstUserMessage == firstUserMessage
            }
        }

        switch candidates.count {
        case 0: return .notFound
        case 1: return .matched(candidates[0])
        default: return .ambiguous(candidates)
        }
    }

    /// Every live process whose argv is exactly the Codex Desktop main binary, ascending.
    ///
    /// `ChatGPT.app` hosts Codex Desktop; the main binary path is the app's own. A wrong pid here
    /// degrades to `.noWindow` at targeting, never to a write against another application.
    static func codexMainPids(in rows: [AgentWindowProcessRow], mainPath: String) -> [pid_t] {
        rows
            .filter { $0.arguments == mainPath || $0.arguments.hasPrefix(mainPath + " ") }
            .map(\.pid)
            .sorted()
    }
}

/// The live, filesystem-backed side of Codex Desktop state, behind a seam so tests use fixtures.
protocol CodexWindowStateReading {
    /// The thread's registry row, nil when the app does not know the id.
    func threadRecord(_ threadId: String) -> CodexThreadRecord?
    /// The thread's display title from `session_index.jsonl`, nil when absent.
    func threadName(_ threadId: String) -> String?
}

/// Reads Codex Desktop state the same way the app writes it: the registry is the app's own sqlite
/// database (read-only, safe against the app's concurrent WAL writer), the display title is the app's
/// own JSONL index.
struct CodexWindowState: CodexWindowStateReading {
    let sqlitePath: String
    let sessionIndexPath: String

    func threadRecord(_ threadId: String) -> CodexThreadRecord? {
        guard let json = Self.sqliteJSON(
            path: sqlitePath,
            query: """
            SELECT id, title, cwd, first_user_message FROM threads \
            WHERE id = '\(Self.sqliteLiteral(threadId))' LIMIT 1;
            """
        ) else { return nil }
        return CodexWindowSessionResolver.parseThreadsRows(json).first
    }

    func threadName(_ threadId: String) -> String? {
        guard let text = try? String(contentsOfFile: sessionIndexPath, encoding: .utf8) else {
            return nil
        }
        return CodexWindowSessionResolver.parseSessionIndex(text)
            .first { $0.threadId == threadId }?.threadName
    }

    /// Runs a read-only query through the system sqlite3 CLI and returns its JSON output.
    ///
    /// The host reads the app's live database; `-readonly` keeps the read out of its write path and
    /// harmless to the WAL. A missing or unreadable database means "no such thread", not a failure.
    static func sqliteJSON(path: String, query: String) -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = ["-readonly", "-json", path, query]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = Pipe()
        guard (try? process.run()) != nil else { return nil }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0, !data.isEmpty else { return nil }
        return data
    }

    /// Doubles embedded quotes so a thread id from the wire cannot break out of the SQL literal.
    static func sqliteLiteral(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "''")
    }
}

/// Turns a resolved Codex Desktop window frame into the window and Desktop the composer writer needs.
///
/// Like the Claude targeting, windows come from the shared desktop audit rather than a window list of
/// this feature's own. Unlike Claude, the pid owns several windows, so the AUDIT window is chosen by
/// the frame the accessibility scan matched -- the AX API exposes no window id, and the frame is the
/// only shared fact between the two views. A single layer-0 window needs no disambiguation.
enum CodexWindowTargeting {
    static func target(
        sessionId: String,
        mainPid: pid_t,
        frame: CGRect,
        in snapshot: WorkspaceDesktopSnapshot
    ) -> Result<AgentWindowSessionTarget, AgentWindowInputReason> {
        guard let activeSpaceID = snapshot.activeSpaceID, snapshot.diagnostic == nil else {
            return .failure(.placementUnavailable)
        }
        let candidates = snapshot.windows
            .filter { $0.ownerPID == mainPid && $0.layer == 0 }
            .filter { $0.spaceIDs.count == 1 }
            .sorted { $0.windowID < $1.windowID }
        guard !candidates.isEmpty else { return .failure(.noWindow) }
        let window: WorkspaceDesktopWindow
        if candidates.count == 1 {
            window = candidates[0]
        } else if let matched = candidates.first(where: {
            abs($0.bounds.origin.x - frame.origin.x) < 2
                && abs($0.bounds.origin.y - frame.origin.y) < 2
                && abs($0.bounds.size.width - frame.size.width) < 2
                && abs($0.bounds.size.height - frame.size.height) < 2
        }) {
            window = matched
        } else {
            return .failure(.noWindow)
        }
        guard let homeSpaceID = window.spaceID else { return .failure(.noWindow) }
        return .success(AgentWindowSessionTarget(
            sessionId: sessionId,
            claudeMainPid: mainPid,
            windowID: window.windowID,
            homeSpaceID: homeSpaceID,
            activeSpaceID: activeSpaceID,
            frame: window.bounds
        ))
    }
}
