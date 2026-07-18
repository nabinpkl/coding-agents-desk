import AppKit
import XCTest
@testable import AgentDeskHost

@MainActor
final class ActivityBarTests: XCTestCase {
    func testSelectingSourceControlUpdatesSelectionAndFiresOnce() throws {
        let bar = ActivityBar()
        var selected: [SidebarTab] = []
        bar.onSelect = { selected.append($0) }
        let button = try XCTUnwrap(button(identifier: "activity-source-control", in: bar.view))

        button.performClick(nil)
        button.performClick(nil)

        XCTAssertEqual(bar.selected, .sourceControl)
        XCTAssertEqual(selected, [.sourceControl])
        XCTAssertEqual(button.accessibilityValue() as? String, "selected")
    }

    func testSourceControlCountHasAccessibleExactValueAndCapsVisibleText() throws {
        let bar = ActivityBar()
        bar.setSourceControlCount(123)
        let badge = try XCTUnwrap(view(identifier: "source-control-count", in: bar.view))

        XCTAssertFalse(badge.isHidden)
        XCTAssertEqual(badge.accessibilityLabel(), "123 source control changes")
        XCTAssertEqual(badge.accessibilityValue() as? Int, 123)
        XCTAssertEqual(try XCTUnwrap(text(in: badge)), "99+")

        bar.setSourceControlCount(0)
        XCTAssertTrue(badge.isHidden)
    }

    private func button(identifier: String, in root: NSView) -> NSButton? {
        if let button = root as? NSButton, button.accessibilityIdentifier() == identifier { return button }
        return root.subviews.lazy.compactMap { self.button(identifier: identifier, in: $0) }.first
    }

    private func view(identifier: String, in root: NSView) -> NSView? {
        if root.accessibilityIdentifier() == identifier { return root }
        return root.subviews.lazy.compactMap { self.view(identifier: identifier, in: $0) }.first
    }

    private func text(in root: NSView) -> String? {
        if let label = root as? NSTextField { return label.stringValue }
        return root.subviews.lazy.compactMap { self.text(in: $0) }.first
    }
}
