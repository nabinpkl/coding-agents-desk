import Foundation
import XCTest
@testable import AgentDeskHost

final class DirectoryListingTests: XCTestCase {
    func testListingUsesTreeOrderingAndGitDecorations() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let source = root.appendingPathComponent("Sources", isDirectory: true)
        let readme = root.appendingPathComponent("README.md")
        let untracked = root.appendingPathComponent("notes.txt")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try Data().write(to: readme)
        try Data().write(to: untracked)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(".git", isDirectory: true),
            withIntermediateDirectories: true
        )

        let status = GitStatus(byPath: [
            source.appendingPathComponent("main.swift"): .modified,
            untracked: .untracked,
        ])

        let entries = directoryListing(directory: root, workspaceRoot: root, gitStatus: status)

        XCTAssertEqual(entries.map { $0.url.lastPathComponent }, ["Sources", "notes.txt", "README.md"])
        XCTAssertEqual(entries.map(\.git), [.modified, .untracked, nil])
        XCTAssertEqual(entries.map(\.isDirectory), [true, false, false])
    }

    func testListingRejectsDirectoryOutsideWorkspaceRoot() throws {
        let root = try temporaryDirectory()
        let outside = try temporaryDirectory()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        try Data().write(to: outside.appendingPathComponent("secret.txt"))

        XCTAssertTrue(
            directoryListing(directory: outside, workspaceRoot: root, gitStatus: GitStatus.empty).isEmpty
        )
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("directory-listing-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
