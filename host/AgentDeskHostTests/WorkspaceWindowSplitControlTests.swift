import AppKit
import Testing

@testable import AgentDeskHost

/// At file scope, not inside the suite: a parameterized test's arguments are read before the suite's
/// main-actor isolation applies.
private let splitControlKinds: [WorkspaceWindowKind] = [.agents, .ide, .terminal]

/// The chip that opens a window and the chevron that lists the open ones are one control with two
/// halves. What matters is that the halves stay distinguishable -- to the user, to a UI test, and to
/// the click that arrives while the shell's panel is not key.
@MainActor
struct WorkspaceWindowSplitControlTests {
    @Test(arguments: splitControlKinds)
    func eachChipNamesItsOwnFamilyOnBothHalves(kind: WorkspaceWindowKind) {
        let control = WorkspaceWindowSplitControl(kind: kind, open: {}, chooser: { NSMenu() })

        #expect(control.segmentCount == 2)
        #expect(control.label(forSegment: 0) == "＋ \(kind.label)")
        #expect(control.toolTip(forSegment: 0) == "Open a new \(kind.label) window")
        // The chevron half carries a glyph, not a label: two labelled halves would read as two chips.
        #expect(control.label(forSegment: 1)?.isEmpty ?? true)
        #expect(control.image(forSegment: 1) != nil)
        #expect(control.toolTip(forSegment: 1) == "List open \(kind.label) windows")
        // Both chips are on screen at once, so a UI test needs to be able to say which it is driving.
        #expect(control.accessibilityIdentifier() == "open-\(kind.identifierPrefix)")
    }

    @Test(arguments: splitControlKinds)
    func theWideHalfOpensAWindow(kind: WorkspaceWindowKind) {
        var opened = 0
        var choosersBuilt = 0
        let control = WorkspaceWindowSplitControl(
            kind: kind,
            open: { opened += 1 },
            chooser: {
                choosersBuilt += 1
                return NSMenu()
            }
        )

        // Segment 0 is the half the configuration test found carrying the "＋" label.
        control.activateSegmentForTesting(0)

        // The two halves share one bezel and one action, so an open that also built the list -- or a
        // list that also opened a window -- is the failure mode worth pinning.
        #expect(opened == 1)
        #expect(choosersBuilt == 0)
    }

    @Test func theChevronHalfAsksForAFreshListEveryTime() {
        var choosersBuilt = 0
        let control = WorkspaceWindowSplitControl(
            kind: .ide,
            open: {},
            chooser: {
                choosersBuilt += 1
                return NSMenu()
            }
        )

        _ = control.chooserMenuForTesting()
        _ = control.chooserMenuForTesting()

        // Built at the moment it opens, not held: a cached menu would offer to close a window that
        // has since closed itself and omit one opened since.
        #expect(choosersBuilt == 2)
    }

    @Test func itTakesTheFirstMouse() {
        let control = WorkspaceWindowSplitControl(kind: .agents, open: {}, chooser: { NSMenu() })

        // The shell's top bar is a non-activating panel: a control that refused the first mouse would
        // swallow the click that reaches it while the panel is not key and cost the user a second one.
        #expect(control.acceptsFirstMouse(for: nil))
    }
}
