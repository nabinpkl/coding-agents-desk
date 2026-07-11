import Foundation
import XCTest
@testable import AgentDeskHost

final class FileTreeTests: XCTestCase {
    private func entry(_ name: String, dir: Bool) -> DirectoryEntry {
        DirectoryEntry(url: URL(fileURLWithPath: "/root/\(name)"), isDirectory: dir)
    }

    func testDirectoriesSortBeforeFiles() {
        let sorted = sortedVisibleEntries([
            entry("zebra.swift", dir: false),
            entry("apps", dir: true),
            entry("alpha.swift", dir: false),
            entry("Sources", dir: true),
        ])
        XCTAssertEqual(sorted.map { $0.url.lastPathComponent }, ["apps", "Sources", "alpha.swift", "zebra.swift"])
    }

    func testNameSortIsCaseInsensitive() {
        let sorted = sortedVisibleEntries([
            entry("banana.txt", dir: false),
            entry("Apple.txt", dir: false),
            entry("cherry.txt", dir: false),
        ])
        XCTAssertEqual(sorted.map { $0.url.lastPathComponent }, ["Apple.txt", "banana.txt", "cherry.txt"])
    }

    func testDotfilesShownButGitDirHidden() {
        let sorted = sortedVisibleEntries([
            entry(".git", dir: true),
            entry(".env", dir: false),
            entry("README.md", dir: false),
        ])
        // Dotfiles are visible (.env kept); only the VCS internal dir is hidden.
        XCTAssertEqual(sorted.map { $0.url.lastPathComponent }, [".env", "README.md"])
    }

    func testFileNodeReadsAndSortsRealDirectory() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("tree-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir.appendingPathComponent("src"), withIntermediateDirectories: true)
        try Data().write(to: dir.appendingPathComponent("main.swift"))
        try Data().write(to: dir.appendingPathComponent(".hidden"))
        defer { try? fm.removeItem(at: dir) }

        let root = FileNode(url: dir, isDirectory: true)
        let names = root.children().map { $0.name }
        XCTAssertEqual(names, ["src", ".hidden", "main.swift"], "dir first, dotfiles shown")
        XCTAssertTrue(root.children()[0].isDirectory)
    }

    func testFileNodeChildrenAreCachedUntilReconciled() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("cache-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data().write(to: dir.appendingPathComponent("a.txt"))
        defer { try? fm.removeItem(at: dir) }

        let root = FileNode(url: dir, isDirectory: true)
        XCTAssertEqual(root.children().count, 1)

        try Data().write(to: dir.appendingPathComponent("b.txt"))
        XCTAssertEqual(root.children().count, 1, "cached: new file not seen until reconcile")

        root.reconcile()
        XCTAssertEqual(root.children().map(\.name), ["a.txt", "b.txt"], "re-read after reconcile")
    }

    func testReconcileKeepsSurvivingNodeIdentityAndDropsRemoved() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("reconcile-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data().write(to: dir.appendingPathComponent("keep.txt"))
        try Data().write(to: dir.appendingPathComponent("gone.txt"))
        defer { try? fm.removeItem(at: dir) }

        let root = FileNode(url: dir, isDirectory: true)
        let keepBefore = root.children().first { $0.name == "keep.txt" }

        try fm.removeItem(at: dir.appendingPathComponent("gone.txt"))
        try Data().write(to: dir.appendingPathComponent("added.txt"))
        root.reconcile()

        let names = root.children().map(\.name)
        XCTAssertEqual(names, ["added.txt", "keep.txt"], "removed dropped, added inserted")
        let keepAfter = root.children().first { $0.name == "keep.txt" }
        XCTAssertTrue(keepBefore === keepAfter, "surviving node keeps identity so expansion is preserved")
    }

    func testFileNodeFileHasNoChildren() {
        let node = FileNode(url: URL(fileURLWithPath: "/root/file.txt"), isDirectory: false)
        XCTAssertTrue(node.children().isEmpty)
    }
}
