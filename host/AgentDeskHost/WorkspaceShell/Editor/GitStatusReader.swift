import Foundation
import os
import AgentDeskWire

public struct WorkspaceGitSnapshot: Sendable {
    public let status: GitStatus
    public let entries: [WorkspaceGitStatusEntry]

    public init(status: GitStatus, entries: [WorkspaceGitStatusEntry]) {
        self.status = status
        self.entries = entries
    }
}

/// Reads a workspace folder's git status by shelling out to `git`. The I/O edge over the
/// pure `parsePorcelain`: it locates the repo root, runs porcelain, and hands the text to
/// the parser. One real implementation, exercised by running — no protocol (the pure parse
/// is the tested part; consumers take a `GitStatus` value, not this reader).
///
/// A workspace need not be a git repo (PRD story 21): when `rev-parse` fails there is no
/// repo, and we return `GitStatus.empty` quietly rather than treating it as an error.
/// Synchronous; the caller runs it off the main thread.
public final class GitStatusReader: Sendable {
    private let gitPath: String
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskHost", category: "git-status")

    public init(gitPath: String = "/usr/bin/git") {
        self.gitPath = gitPath
    }

    /// The working-tree status for the repo containing `workspaceRoot`. Paths are resolved
    /// against the repo's top level (a workspace may be a subdirectory of the repo).
    public func read(workspaceRoot: URL) -> GitStatus {
        readSnapshot(workspaceRoot: workspaceRoot).status
    }

    public func readSnapshot(workspaceRoot: URL) -> WorkspaceGitSnapshot {
        guard let repoRoot = repoRoot(for: workspaceRoot) else {
            return WorkspaceGitSnapshot(status: .empty, entries: [])
        }
        // `--ignored=matching` reports ignored paths (code `!!`) collapsed to the matching
        // dir/file (e.g. `.build/`), not every file inside — cheap, and the decoration
        // greys their descendants. Without it, ignored files would look untracked.
        guard let output = run(["-C", workspaceRoot.path,
                                "status", "--porcelain=v1", "-z",
                                "--untracked-files=all", "--ignored=matching"]) else {
            return WorkspaceGitSnapshot(status: .empty, entries: [])
        }
        return WorkspaceGitSnapshot(
            status: GitStatus(byPath: parsePorcelain(output, repoRoot: repoRoot)),
            entries: parseWorkspaceGitEntries(output, repoRoot: repoRoot, workspaceRoot: workspaceRoot)
        )
    }

    /// The repo's top-level directory, or `nil` when `workspaceRoot` isn't in a git repo
    /// (the normal non-repo case — `rev-parse` exits non-zero and we stay quiet).
    private func repoRoot(for folder: URL) -> URL? {
        guard let output = run(["-C", folder.path, "rev-parse", "--show-toplevel"]) else { return nil }
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : URL(fileURLWithPath: path).resolvingSymlinksInPath()
    }

    /// Run `git` with `args`, returning stdout on a clean exit, else `nil`. A non-zero exit
    /// is expected for non-repos (caller treats `nil` as "no status"); only a failure to
    /// launch `git` at all is logged.
    private func run(_ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: gitPath)
        process.arguments = args
        // GIT_OPTIONAL_LOCKS=0 stops `git status` from refreshing (rewriting) .git/index as
        // a side effect. Without it, each read writes .git/index, the folder watcher sees
        // that write and triggers another read — a feedback loop that reloads the tree
        // several times a second. This is the standard fix for scripted status polling.
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            logger.error("git launch failed: \(String(describing: error), privacy: .public)")
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
