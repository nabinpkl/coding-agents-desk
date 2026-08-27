// The process-table reads the host still does for itself.
//
// What is left of a much larger file. Claude and Codex session resolution moved to the sidecar
// (ADR-0110), where it is `/bin/ps` output and a filter and needs no app build to change. This
// remains because `CodexWindowLauncher` is host-owned window placement -- it opens a window and waits
// for it to appear -- and it needs to know which process to watch.

import Foundation

/// One row of the live process table, reduced to what session resolution needs.
struct AgentWindowProcessRow: Equatable, Sendable {
    let pid: pid_t
    let parentPid: pid_t
    let arguments: String
}

enum AgentWindowProcessTable {
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
