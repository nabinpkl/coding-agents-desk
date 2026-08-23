import AppKit
import XCTest
@testable import AgentDeskHost

/// The live watcher's refresh path.
///
/// Regression cover for a main-thread crash on 2026-08-23 (`EXC_BREAKPOINT`, Swift
/// "Index out of range", inside `-[NSOutlineView itemAtRow:]`): `refreshPreservingState`
/// reconciled the tree and only then read the outline's rows to remember what was
/// expanded. By that point a deleted file had shortened `FileNode.children()` while the
/// outline still held the pre-reconcile row layout, so AppKit's lazy row fill asked the
/// data source for a child index that no longer existed.
///
/// `testReconcileLeavesTheRowCountStale` pins the hazard itself. The trap on top of it is
/// NOT reproducible here: it needs AppKit to fill a row entry lazily, and an outline in a
/// test host materializes every row up front (measured: 3 of 14 rows visible in a real
/// window, all 14 entries already loaded). So the rest of this file covers the observable
/// contract across a shrinking reconcile, not the crash.
@MainActor
final class FilePaneRefreshTests: XCTestCase {
    private var directory = URL(fileURLWithPath: "/")

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("file-pane-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ name: String) throws {
        try Data().write(to: directory.appendingPathComponent(name))
    }

    private func folder(_ name: String, files: [String]) throws -> URL {
        let sub = directory.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        for file in files { try Data().write(to: sub.appendingPathComponent(file)) }
        return sub
    }

    /// Show `directory` with every folder expanded, which is the state the crash needed.
    private func expandedPane() -> (FilePane, NSOutlineView, FileNode) {
        let pane = FilePane()
        let root = FileNode(url: directory, isDirectory: true)
        pane.show(root: root)
        let outline = pane.outlineForTesting
        outline.expandItem(nil, expandChildren: true)
        return (pane, outline, root)
    }

    func testRefreshSurvivesFilesDisappearingFromAnExpandedFolder() throws {
        let sub = try folder("src", files: (0..<12).map { "file\($0).swift" })
        try write("README.md")
        let (pane, outline, _) = expandedPane()
        XCTAssertEqual(outline.numberOfRows, 14, "root README + src + its 12 files")

        // What the watcher reports: most of an expanded folder is gone. Before the fix
        // this trapped, because the reconcile ran before the rows were read.
        for index in 3..<12 { try FileManager.default.removeItem(at: sub.appendingPathComponent("file\(index).swift")) }
        pane.refreshPreservingState()

        XCTAssertEqual(outline.numberOfRows, 5, "root README + src + its 3 survivors")
    }

    func testRefreshKeepsExpansionAndSelectionAcrossAReconcile() throws {
        let sub = try folder("src", files: ["a.swift", "b.swift"])
        try write("README.md")
        let (pane, outline, root) = expandedPane()
        let src = try XCTUnwrap(root.children().first { $0.name == "src" })
        let keep = try XCTUnwrap(src.children().first { $0.name == "a.swift" })
        outline.selectRowIndexes([outline.row(forItem: keep)], byExtendingSelection: false)

        try FileManager.default.removeItem(at: sub.appendingPathComponent("b.swift"))
        try Data().write(to: sub.appendingPathComponent("c.swift"))
        pane.refreshPreservingState()

        XCTAssertTrue(outline.isItemExpanded(src), "the folder stays open across the refresh")
        XCTAssertTrue(outline.item(atRow: outline.selectedRow) as? FileNode === keep, "selection follows the surviving node")
        XCTAssertEqual(src.children().map(\.name), ["a.swift", "c.swift"])
    }

    /// Why the capture has to happen before the reconcile: a reconcile tells the outline
    /// nothing, so between it and the next `reloadData` the row count describes a tree that
    /// no longer exists. Any question asked of the outline in that window is answered
    /// against the stale layout, which is where the crash came from.
    func testReconcileLeavesTheRowCountStale() throws {
        let sub = try folder("src", files: (0..<12).map { "file\($0).swift" })
        let (_, outline, root) = expandedPane()
        XCTAssertEqual(outline.numberOfRows, 13)

        for index in 3..<12 { try FileManager.default.removeItem(at: sub.appendingPathComponent("file\(index).swift")) }
        root.reconcile()

        XCTAssertEqual(root.children().first?.children().count, 3, "the tree has shrunk")
        XCTAssertEqual(outline.numberOfRows, 13, "...and the outline has not been told")
    }

    /// A refresh with nothing selected must not read row -1.
    func testRefreshWithNoSelectionIsHarmless() throws {
        _ = try folder("src", files: ["a.swift"])
        let (pane, outline, _) = expandedPane()
        XCTAssertEqual(outline.selectedRow, -1)

        pane.refreshPreservingState()

        XCTAssertEqual(outline.selectedRow, -1)
        XCTAssertEqual(outline.numberOfRows, 2)
    }
}
