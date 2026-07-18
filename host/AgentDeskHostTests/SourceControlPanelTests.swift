import AppKit
import XCTest
@testable import AgentDeskHost

@MainActor
final class SourceControlPanelTests: XCTestCase {
    func testPanelExcludesIgnoredChangesAndKeyboardOpensSelectedFile() throws {
        let root = URL(fileURLWithPath: "/repo").resolvingSymlinksInPath()
        let modified = root.appendingPathComponent("Sources/main.swift")
        let ignored = root.appendingPathComponent(".build")
        let outside = URL(fileURLWithPath: "/outside/secret.swift")
        let panel = SourceControlPanel()
        let visibleCount = panel.apply(
            GitStatus(byPath: [modified: .modified, ignored: .ignored, outside: .modified]),
            root: root
        )
        var activated: URL?
        panel.onActivate = { activated = $0 }
        let table = try XCTUnwrap(table(in: panel.view))

        XCTAssertEqual(visibleCount, 1)
        XCTAssertEqual(table.numberOfRows, 1)
        table.selectRowIndexes([0], byExtendingSelection: false)
        table.keyDown(with: Self.key(" "))

        XCTAssertEqual(activated, modified)
        let cell = try XCTUnwrap(panel.tableView(table, viewFor: nil, row: 0) as? NSTableCellView)
        XCTAssertEqual(cell.accessibilityRole(), .button)
        XCTAssertEqual(cell.accessibilityLabel(), "main.swift")
    }

    func testPanelZoomUpdatesRowsAndEmptyStateIsExplicit() throws {
        let root = URL(fileURLWithPath: "/repo").resolvingSymlinksInPath()
        let file = root.appendingPathComponent("main.swift")
        let panel = SourceControlPanel()
        let zoom = WorkspaceTextZoom(step: 2)

        panel.setTextZoom(zoom)
        panel.apply(GitStatus(byPath: [file: .modified]), root: root)
        let table = try XCTUnwrap(table(in: panel.view))
        XCTAssertEqual(table.rowHeight, zoom.sidebarRowHeight)

        panel.clear()
        let empty = try XCTUnwrap(label(value: "No changes", in: panel.view))
        XCTAssertFalse(empty.isHidden)
        XCTAssertTrue(table.enclosingScrollView?.isHidden == true)
    }

    private func table(in root: NSView) -> NSTableView? {
        if let table = root as? NSTableView { return table }
        if let scroll = root as? NSScrollView, let table = scroll.documentView as? NSTableView { return table }
        return root.subviews.lazy.compactMap { self.table(in: $0) }.first
    }

    private func label(value: String, in root: NSView) -> NSTextField? {
        if let label = root as? NSTextField, label.stringValue == value { return label }
        return root.subviews.lazy.compactMap { self.label(value: value, in: $0) }.first
    }

    private static func key(_ characters: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: 0
        )!
    }
}
