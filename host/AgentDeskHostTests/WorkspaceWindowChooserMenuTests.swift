import AppKit
import Foundation
import Testing

@testable import AgentDeskHost

/// At file scope, not inside the suite: a parameterized test's arguments are read before the suite's
/// main-actor isolation applies.
private let chooserKinds: [WorkspaceWindowKind] = [.agents, .ide, .terminal]

/// The chooser hands a window id back to something that owns the window. What matters here is that
/// it hands back the RIGHT one, for the RIGHT action: rows are built from a list, and an off-by-one
/// between the row shown and the id carried would close or raise a window other than the one under
/// the pointer -- and the two actions share a row, a few pixels apart.
///
/// Every case runs against every family, because one menu serves them all and a kind that leaked from
/// the wrong place would name IDE windows "Agents" or hand a UI test identifiers it cannot tell apart.
@MainActor
struct WorkspaceWindowChooserMenuTests {
    private static func windows(_ kind: WorkspaceWindowKind) -> (first: WorkspaceWindowSummary, second: WorkspaceWindowSummary) {
        (
            WorkspaceWindowSummary(
                id: UUID(uuidString: "1E2C0F80-6C1A-4F5E-9A63-6C6D3B1F0A11")!,
                kind: kind,
                desktopOrdinal: 0,
                cascadeOrdinal: 0
            ),
            WorkspaceWindowSummary(
                id: UUID(uuidString: "2A7B4D91-88F3-4C20-B1E7-0D5C9E4A2233")!,
                kind: kind,
                desktopOrdinal: 0,
                cascadeOrdinal: 1
            )
        )
    }

    @Test(arguments: chooserKinds)
    func withNoWindowsOpenItSaysSoInsteadOfShowingAnEmptyMenu(kind: WorkspaceWindowKind) {
        let menu = WorkspaceWindowChooserMenu.make(kind: kind, windows: [], focus: { _ in }, close: { _ in })

        #expect(menu.items.count == 1)
        // A menu with nothing in it reads as broken. Naming the state is the difference between "no
        // windows are open" and "this control does not work".
        #expect(menu.items[0].title == "No \(kind.label) windows open")
        #expect(!menu.items[0].isEnabled)
        #expect(menu.items[0].view == nil)
    }

    @Test(arguments: chooserKinds)
    func everyOpenWindowGetsItsOwnNamedRow(kind: WorkspaceWindowKind) {
        let (first, second) = Self.windows(kind)
        let menu = WorkspaceWindowChooserMenu.make(kind: kind, windows: [first, second], focus: { _ in }, close: { _ in })

        #expect(menu.items.count == 2)
        #expect(menu.items.map(\.title) == ["\(kind.label) 1 · Desktop 1", "\(kind.label) 2 · Desktop 1"])
        #expect(menu.items.compactMap { $0.representedObject as? UUID } == [first.id, second.id])
        #expect(menu.items.allSatisfy { $0.view is WorkspaceWindowChooserRow })
    }

    @Test(arguments: chooserKinds)
    func aRowsCloseButtonClosesThatRowsWindow(kind: WorkspaceWindowKind) throws {
        let (first, second) = Self.windows(kind)
        var focused: [UUID] = []
        var closed: [UUID] = []
        let menu = WorkspaceWindowChooserMenu.make(
            kind: kind,
            windows: [first, second],
            focus: { focused.append($0) },
            close: { closed.append($0) }
        )

        let row = try #require(menu.items[1].view as? WorkspaceWindowChooserRow)
        let button = try #require(row.subviews.compactMap { $0 as? NSButton }.first)
        button.performClick(nil)

        // The second row's button closes the second window, not the first and not all of them. The
        // two actions share a row, so a close that also went to the window would be a wrong answer.
        #expect(closed == [second.id])
        #expect(focused.isEmpty)
    }

    @Test(arguments: chooserKinds)
    func clickingARowGoesToThatRowsWindow(kind: WorkspaceWindowKind) throws {
        let (first, second) = Self.windows(kind)
        var focused: [UUID] = []
        var closed: [UUID] = []
        let menu = WorkspaceWindowChooserMenu.make(
            kind: kind,
            windows: [first, second],
            focus: { focused.append($0) },
            close: { closed.append($0) }
        )

        let row = try #require(menu.items[1].view as? WorkspaceWindowChooserRow)
        row.mouseUp(with: Self.click())

        #expect(focused == [second.id])
        #expect(closed.isEmpty)
    }

    @Test(arguments: chooserKinds)
    func onlyTheRowUnderThePointerIsHighlighted(kind: WorkspaceWindowKind) throws {
        let (first, second) = Self.windows(kind)
        let menu = WorkspaceWindowChooserMenu.make(kind: kind, windows: [first, second], focus: { _ in }, close: { _ in })
        let rows = try menu.items.map { try #require($0.view as? WorkspaceWindowChooserRow) }

        rows[1].mouseEntered(with: Self.crossing(.mouseEntered))

        // A view item gets no highlighting from AppKit, so a row that did not draw its own would
        // leave the pointer over an unlit list and the click target unmarked.
        #expect(rows.map(\.isHighlighted) == [false, true])

        rows[1].mouseExited(with: Self.crossing(.mouseExited))

        #expect(rows.map(\.isHighlighted) == [false, false])
    }

    @Test(arguments: chooserKinds)
    func eachRowCarriesAnIdentifiedCloseControl(kind: WorkspaceWindowKind) throws {
        let (first, _) = Self.windows(kind)
        let menu = WorkspaceWindowChooserMenu.make(kind: kind, windows: [first], focus: { _ in }, close: { _ in })
        let row = try #require(menu.items[0].view as? WorkspaceWindowChooserRow)

        let identifiers = row.subviews.compactMap { $0.accessibilityIdentifier() }
        // Per-window identifiers, not one shared id: a UI test driving this has to be able to say
        // WHICH window it is closing, and two rows are otherwise indistinguishable to it. The kind
        // is in the identifier too, because both chooser menus are open to the same UI test.
        #expect(identifiers.contains("\(kind.identifierPrefix)-window-chooser-close-\(first.id.uuidString)"))
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
