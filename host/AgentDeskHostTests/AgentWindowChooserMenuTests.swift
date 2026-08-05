import AppKit
import Foundation
import Testing

@testable import AgentDeskHost

/// The chooser hands a window id back to something that owns the window. What matters here is that
/// it hands back the RIGHT one, for the RIGHT action: rows are built from a list, and an off-by-one
/// between the row shown and the id carried would close or raise a window other than the one under
/// the pointer -- and the two actions share a row, a few pixels apart.
@MainActor
struct AgentWindowChooserMenuTests {
    private let first = AgentWindowSummary(
        id: UUID(uuidString: "1E2C0F80-6C1A-4F5E-9A63-6C6D3B1F0A11")!,
        desktopOrdinal: 0,
        cascadeOrdinal: 0
    )
    private let second = AgentWindowSummary(
        id: UUID(uuidString: "2A7B4D91-88F3-4C20-B1E7-0D5C9E4A2233")!,
        desktopOrdinal: 0,
        cascadeOrdinal: 1
    )

    @Test func withNoWindowsOpenItSaysSoInsteadOfShowingAnEmptyMenu() {
        let menu = AgentWindowChooserMenu.make(windows: [], focus: { _ in }, close: { _ in })

        #expect(menu.items.count == 1)
        // A menu with nothing in it reads as broken. Naming the state is the difference between "no
        // windows are open" and "this control does not work".
        #expect(menu.items[0].title == "No Agents windows open")
        #expect(!menu.items[0].isEnabled)
        #expect(menu.items[0].view == nil)
    }

    @Test func everyOpenWindowGetsItsOwnNamedRow() {
        let menu = AgentWindowChooserMenu.make(windows: [first, second], focus: { _ in }, close: { _ in })

        #expect(menu.items.count == 2)
        #expect(menu.items.map(\.title) == ["Agents 1 · Desktop 1", "Agents 2 · Desktop 1"])
        #expect(menu.items.compactMap { $0.representedObject as? UUID } == [first.id, second.id])
        #expect(menu.items.allSatisfy { $0.view is AgentWindowChooserRow })
    }

    @Test func aRowsCloseButtonClosesThatRowsWindow() throws {
        var focused: [UUID] = []
        var closed: [UUID] = []
        let menu = AgentWindowChooserMenu.make(
            windows: [first, second],
            focus: { focused.append($0) },
            close: { closed.append($0) }
        )

        let row = try #require(menu.items[1].view as? AgentWindowChooserRow)
        let button = try #require(row.subviews.compactMap { $0 as? NSButton }.first)
        button.performClick(nil)

        // The second row's button closes the second window, not the first and not all of them. The
        // two actions share a row, so a close that also went to the window would be a wrong answer.
        #expect(closed == [second.id])
        #expect(focused.isEmpty)
    }

    @Test func clickingARowGoesToThatRowsWindow() throws {
        var focused: [UUID] = []
        var closed: [UUID] = []
        let menu = AgentWindowChooserMenu.make(
            windows: [first, second],
            focus: { focused.append($0) },
            close: { closed.append($0) }
        )

        let row = try #require(menu.items[1].view as? AgentWindowChooserRow)
        row.mouseUp(with: Self.click())

        #expect(focused == [second.id])
        #expect(closed.isEmpty)
    }

    @Test func onlyTheRowUnderThePointerIsHighlighted() throws {
        let menu = AgentWindowChooserMenu.make(windows: [first, second], focus: { _ in }, close: { _ in })
        let rows = try menu.items.map { try #require($0.view as? AgentWindowChooserRow) }

        rows[1].mouseEntered(with: Self.crossing(.mouseEntered))

        // A view item gets no highlighting from AppKit, so a row that did not draw its own would
        // leave the pointer over an unlit list and the click target unmarked.
        #expect(rows.map(\.isHighlighted) == [false, true])

        rows[1].mouseExited(with: Self.crossing(.mouseExited))

        #expect(rows.map(\.isHighlighted) == [false, false])
    }

    @Test func eachRowCarriesAnIdentifiedCloseControl() throws {
        let menu = AgentWindowChooserMenu.make(windows: [first], focus: { _ in }, close: { _ in })
        let row = try #require(menu.items[0].view as? AgentWindowChooserRow)

        let identifiers = row.subviews.compactMap { $0.accessibilityIdentifier() }
        // Per-window identifiers, not one shared id: a UI test driving this has to be able to say
        // WHICH window it is closing, and two rows are otherwise indistinguishable to it.
        #expect(identifiers.contains("agents-window-chooser-close-\(first.id.uuidString)"))
    }

    /// The rows read real AppKit events rather than a test-only entry point, so what a test drives is
    /// what a pointer inside a live menu drives. Enter and exit are a separate AppKit constructor from
    /// the click; `mouseEvent(with:...)` rejects them outright.
    private static func click() -> NSEvent {
        NSEvent.mouseEvent(
            with: .leftMouseUp,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 0
        )!
    }

    private static func crossing(_ type: NSEvent.EventType) -> NSEvent {
        NSEvent.enterExitEvent(
            with: type,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 0,
            trackingNumber: 0,
            userData: nil
        )!
    }
}
