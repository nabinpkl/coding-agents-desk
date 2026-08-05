import AppKit
import Foundation
import Testing

@testable import AgentDeskHost

/// The chooser hands a window id back to something that owns the window. What matters here is that
/// it hands back the RIGHT one: rows are built from a list, and an off-by-one between the row shown
/// and the id carried would close a window the user was looking at rather than the one they clicked.
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
        let menu = AgentWindowChooserMenu.make(windows: [], close: { _ in })

        #expect(menu.items.count == 1)
        // A menu with nothing in it reads as broken. Naming the state is the difference between "no
        // windows are open" and "this control does not work".
        #expect(menu.items[0].title == "No Agents windows open")
        #expect(!menu.items[0].isEnabled)
        #expect(menu.items[0].view == nil)
    }

    @Test func everyOpenWindowGetsItsOwnNamedRow() {
        let menu = AgentWindowChooserMenu.make(windows: [first, second], close: { _ in })

        #expect(menu.items.count == 2)
        #expect(menu.items.map(\.title) == ["Agents 1 · Desktop 1", "Agents 2 · Desktop 1"])
        #expect(menu.items.compactMap { $0.representedObject as? UUID } == [first.id, second.id])
        #expect(menu.items.allSatisfy { $0.view is AgentWindowChooserRow })
    }

    @Test func aRowsCloseButtonClosesThatRowsWindow() throws {
        var closed: [UUID] = []
        let menu = AgentWindowChooserMenu.make(windows: [first, second], close: { closed.append($0) })

        let row = try #require(menu.items[1].view as? AgentWindowChooserRow)
        row.performCloseForTesting()

        // The second row's button closes the second window, not the first and not all of them.
        #expect(closed == [second.id])
    }

    @Test func eachRowCarriesAnIdentifiedCloseControl() throws {
        let menu = AgentWindowChooserMenu.make(windows: [first], close: { _ in })
        let row = try #require(menu.items[0].view as? AgentWindowChooserRow)

        let identifiers = row.subviews.compactMap { $0.accessibilityIdentifier() }
        // Per-window identifiers, not one shared id: a UI test driving this has to be able to say
        // WHICH window it is closing, and two rows are otherwise indistinguishable to it.
        #expect(identifiers.contains("agents-window-chooser-close-\(first.id.uuidString)"))
    }
}
