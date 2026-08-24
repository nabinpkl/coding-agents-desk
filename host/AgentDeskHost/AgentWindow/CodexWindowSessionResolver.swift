import AgentDeskWire
import AppKit
import Foundation

/// One row of Codex Desktop's own thread registry, reduced to what resolution needs.
///
/// `state_5.sqlite` `threads` is the desktop app's registry: `id` is the SAME thread id the feed keys
/// codex sessions by, `cwd` is the project directory, and `title` is the (lowercased) thread title.
/// Fields resolution does not need are ignored.
struct CodexThreadRecord: Equatable, Sendable {
    let threadId: String
    let title: String
    let cwd: String
}

/// One line of `~/.codex/session_index.jsonl`, the app's display-title index.
///
/// `thread_name` is the title the app SHOWS -- it matches the accessibility header button and the
/// Recents sidebar row exactly, where `threads.title` is lowercased and does not.
struct CodexSessionIndexEntry: Equatable, Sendable {
    let threadId: String
    let threadName: String
}

/// The identity a Codex Desktop window's accessibility tree exposes for the thread it is showing.
///
/// Ground-truthed against the live app. Two layouts exist:
///
/// - The threads-sidebar layout exposes a header bar with a `Project: <name>` popup and a title
///   button (`threadTitle`/`projectName`).
/// - The projects/Recents layout exposes neither, but the sidebar's Recents list pins the window's
///   CURRENT thread as its first row (`recentsFirstRow`) -- verified live: the first row was the
///   window's thread even when another thread had more recent activity, and it followed the window
///   when the thread switched.
///
/// `windowID` is WindowServer's own id for the window, read straight off the accessibility element,
/// and it is what correlates the window to the desktop audit for a Space move. `frame` is carried
/// for the target struct, not for identification.
struct CodexWindowSummary: Equatable, Sendable {
    let windowID: CGWindowID
    let threadTitle: String
    let projectName: String
    /// The title of the first row of the window's Recents list: the thread this window is showing.
    /// nil when the layout exposes no Recents list (the threads-sidebar layout, or no chat open).
    let recentsFirstRow: String?
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
/// The mapping is the app's own state joined to the accessibility tree, never the process tree:
/// Codex Desktop runs ONE `codex app-server` child for every thread of every window, and no child
/// argv or registry file carries the thread id in a window-distinguishing way (probed live). The
/// thread's display title and `cwd` come from `~/.codex` state files; each window's accessibility
/// tree exposes either the header bar identity (thread title button + `Project:` popup) or the
/// Recents first-row pin. Matching is layered:
///
/// - A named thread matches the header title AND project together.
/// - A still-generic thread (`New chat` / `New voice chat` / `Untitled`) drops the title
///   requirement in the header layout: the project popup alone is identity.
/// - Any thread whose display title equals a window's Recents first row matches that window, which
///   is how a thread opened from Recents -- a `cwd` outside the app's project registry -- resolves.
///
/// Conversation content is deliberately NOT matched: the app virtualizes its message list, so what
/// is rendered depends on scroll position and can never be a deterministic anchor.
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
        }
        guard let rows = try? JSONDecoder().decode([Row].self, from: json) else { return [] }
        return rows.compactMap { row in
            guard let cwd = row.cwd, !cwd.isEmpty else { return nil }
            return CodexThreadRecord(
                threadId: row.id,
                title: row.title ?? "",
                cwd: cwd
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

    /// Resolves one thread to the unique window showing it, per the layered rules documented on the
    /// type. More than one candidate at any stage is `.ambiguous`; none is `.notFound`.
    static func resolve(
        threadId: String,
        title: String,
        cwd: String,
        threadName: String,
        windows: [CodexWindowSummary]
    ) -> CodexWindowMatch {
        let project = projectName(for: cwd)
        let displayName = threadName.isEmpty ? title : threadName
        let isGeneric = genericTitles.contains(displayName.lowercased())

        let candidates = windows.filter { window in
            // Header-bar layout: title AND project together, or project alone for a generic title.
            if !window.projectName.isEmpty {
                guard window.projectName == project else { return false }
                if isGeneric { return true }
                let titleMatches = (!threadName.isEmpty && window.threadTitle == threadName)
                    || (!title.isEmpty && window.threadTitle.lowercased() == title.lowercased())
                return titleMatches
            }
            // Projects/Recents layout: the window's current thread is pinned as the first row of its
            // Recents list. A named thread matches its display title exactly; a generic thread
            // matches the generic first row (uniqueness across windows still refuses ambiguity).
            guard let firstRow = window.recentsFirstRow, !firstRow.isEmpty else { return false }
            return firstRow == displayName
                || (!title.isEmpty && firstRow.lowercased() == title.lowercased())
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
            SELECT id, title, cwd FROM threads \
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

/// Turns a resolved Codex Desktop window into the window and Desktop the composer writer needs.
///
/// Like the Claude targeting, windows come from the shared desktop audit rather than a window list of
/// this feature's own. Unlike Claude, the pid owns several windows, and they are told apart by
/// WindowServer's id, which the accessibility scan reads off the window element directly. It used to
/// be a frame comparison with a single-window escape hatch, and both were wrong for the case this
/// feature exists for: two maximized codex windows on two Desktops carry the same frame.
enum CodexWindowTargeting {
    static func target(
        sessionId: String,
        mainPid: pid_t,
        windowID: CGWindowID,
        in snapshot: WorkspaceDesktopSnapshot
    ) -> Result<AgentWindowSessionTarget, AgentWindowInputReason> {
        guard let activeSpaceID = snapshot.activeSpaceID, snapshot.diagnostic == nil else {
            return .failure(.placementUnavailable)
        }
        // Both views name the window by the same id, so this is a lookup rather than a comparison.
        // The pid and layer conditions stay: an id that resolves to another app's window, or to a
        // panel rather than a real window, is a bug worth refusing rather than addressing.
        guard let window = snapshot.windows.first(where: {
            $0.windowID == windowID && $0.ownerPID == mainPid && $0.layer == 0 && $0.spaceIDs.count == 1
        }) else { return .failure(.noWindow) }
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
