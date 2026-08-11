import Testing
import UIKit
import AgentDeskWire

// The picker is on-demand: a bar at rest, tiles only while expanded. These assert the two
// things that make that safe -- the height the layout owner is told to install, and the fact
// that picking closes the list -- plus the bar's read of the current target, which is the
// only place the collapsed state says what the phone is actually watching.
@MainActor
struct WindowPickerStripViewTests {
    private final class Recorder: WindowPickerStripViewDelegate {
        var selections: [UInt32?] = []
        var heightChanges = 0
        var toggles: [Bool] = []

        func windowPicker(_ view: WindowPickerStripView, didSelectWindowId windowId: UInt32?) {
            selections.append(windowId)
        }

        func windowPickerDidChangePreferredHeight(_ view: WindowPickerStripView) {
            heightChanges += 1
        }

        func windowPickerDidToggleExpansion(_ view: WindowPickerStripView) {
            toggles.append(view.isExpanded)
        }
    }

    private func push(_ count: Int) -> WindowListPush {
        WindowListPush(windows: (0..<count).map { i in
            WindowSummary(
                id: UInt32(i + 1),
                spaceId: 100,
                appName: "App\(i + 1)",
                title: "Doc\(i + 1)",
                iconHash: "h\(i + 1)"
            )
        })
    }

    @Test func startsCollapsedToTheBar() {
        let view = WindowPickerStripView()
        view.apply(push: push(3))

        #expect(view.isExpanded == false)
        #expect(view.preferredHeight == WindowPickerStripView.collapsedHeight)
    }

    @Test func expandingReportsTheTallerHeightOnce() {
        let view = WindowPickerStripView()
        let recorder = Recorder()
        view.delegate = recorder
        view.apply(push: push(3))

        view.setExpanded(true)
        #expect(view.preferredHeight == WindowPickerStripView.expandedHeight)
        #expect(recorder.heightChanges == 1)

        // Idempotent: the layout owner should not be asked to re-animate a height it already
        // installed.
        view.setExpanded(true)
        #expect(recorder.heightChanges == 1)
    }

    @Test func collapsingReturnsToTheBarHeight() {
        let view = WindowPickerStripView()
        view.apply(push: push(2))
        view.setExpanded(true)
        view.setExpanded(false)

        #expect(view.preferredHeight == WindowPickerStripView.collapsedHeight)
    }

    // The whole point of the bar: with the tiles closed it still says what the phone is
    // pointed at, so collapsing costs no information.
    @Test func barNamesTheCurrentTarget() {
        let view = WindowPickerStripView()
        view.apply(push: push(2))
        #expect(view.barTitleText == "Whole Desktop")
    }

    // Emptying is a teardown path (hideTrackpad, channel restart). It must not leave the
    // strip holding the tile row's height for a list it no longer has.
    @Test func renderEmptyCollapses() {
        let view = WindowPickerStripView()
        view.apply(push: push(4))
        view.setExpanded(true)
        view.renderEmpty()

        #expect(view.isExpanded == false)
        #expect(view.preferredHeight == WindowPickerStripView.collapsedHeight)
        #expect(view.currentSelection == nil)
    }

    // Open, the strip is the tile row and nothing else: the chevron and glyph move into the
    // row's leading column rather than sitting in a band above it, so the label row's height
    // is not part of the expanded strip.
    @Test func expandedHeightIsTheTileRowAlone() {
        #expect(
            WindowPickerStripView.expandedHeight
                == WindowPickerStripView.tileRowHeight
                    + WindowPickerStripView.rowVerticalPadding * 2
        )
        #expect(WindowPickerStripView.collapsedHeight == WindowPickerStripView.barHeight)
        #expect(WindowPickerStripView.expandedHeight < WindowPickerStripView.barHeight
            + WindowPickerStripView.tileRowHeight)
    }
}
