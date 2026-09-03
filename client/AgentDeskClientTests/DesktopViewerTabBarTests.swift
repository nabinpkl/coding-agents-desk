import Testing
import UIKit
@testable import AgentDeskClient

// The Native/WebView switcher's disclosure. It sits on the Mac's own menu bar, so what is
// pinned here is mostly about what it gives back when it is closed: no reserved height, and
// no touches taken outside the pull tab.
@MainActor
struct DesktopViewerTabBarTests {
    private func laidOut(isExpanded: Bool) -> DesktopViewerTabBar {
        let bar = DesktopViewerTabBar(isExpanded: isExpanded)
        bar.frame = CGRect(x: 0, y: 0, width: 390, height: bar.preferredHeight)
        bar.layoutIfNeeded()
        return bar
    }

    @Test func itOpensInTheStateItWasBuiltWith() {
        #expect(DesktopViewerTabBar(isExpanded: true).isExpanded)
        #expect(DesktopViewerTabBar(isExpanded: false).isExpanded == false)
    }

    // The whole point of the disclosure: closed, the bar reserves nothing, so everything the
    // layout owner chains under its bottom edge gets the Mac's top strip back.
    @Test func aClosedBarReservesNoHeight() {
        #expect(DesktopViewerTabBar(isExpanded: false).preferredHeight == 0)
        #expect(DesktopViewerTabBar(isExpanded: true).preferredHeight
            == DesktopViewerTabBar.expandedHeight)
    }

    // Restoring a remembered disclosure must not write that same value straight back out.
    // The layout owner also closes this bar when another surface takes the screen, and only
    // a deliberate tap is a preference.
    @Test func restoringADisclosureIsNotReportedAsAChoice() {
        let bar = DesktopViewerTabBar(isExpanded: true)
        var reported: [Bool] = []
        bar.onDisclosureChange = { reported.append($0) }

        bar.setExpanded(false)
        bar.setExpanded(true)
        bar.setExpanded(true)

        #expect(bar.isExpanded)
        #expect(reported.isEmpty)
    }

    // The one that matters. Closed, the bar is a full-width zero-height view lying over the
    // Mac's menu bar; if it took touches across that width the video would silently lose its
    // top strip to a control that is not even drawn there.
    @Test func aClosedBarTakesNoTouchesBeyondThePullTab() {
        let bar = laidOut(isExpanded: false)
        let tab = bar.disclosureRect

        #expect(bar.point(inside: CGPoint(x: tab.midX, y: tab.midY), with: nil))
        // Reachable across a full 44pt box centred on the 28pt tab...
        #expect(bar.point(inside: CGPoint(x: tab.minX - 7, y: tab.midY), with: nil))
        // ...and no further, in either direction along the bar.
        #expect(bar.point(inside: CGPoint(x: tab.minX - 12, y: tab.midY), with: nil) == false)
        #expect(bar.point(inside: CGPoint(x: 20, y: tab.midY), with: nil) == false)
        #expect(bar.point(inside: CGPoint(x: 370, y: tab.midY), with: nil) == false)
        // Above the tab is the safe-area inset the closed bar occupies: still not its touch.
        #expect(bar.point(inside: CGPoint(x: 20, y: -20), with: nil) == false)
    }

    // Open, the bar is opaque furniture and owns its own band -- a tap there must not fall
    // through to the Mac behind it -- and the tab stays reachable below its bottom edge, so
    // the control does not move when the bar it closes opens.
    @Test func anOpenBarOwnsItsBandAndKeepsTheTabBelowIt() {
        let bar = laidOut(isExpanded: true)
        let tab = bar.disclosureRect

        #expect(bar.point(inside: CGPoint(x: 20, y: 20), with: nil))
        #expect(bar.point(inside: CGPoint(x: 370, y: 20), with: nil))
        #expect(tab.minY == DesktopViewerTabBar.expandedHeight)
        #expect(bar.point(inside: CGPoint(x: tab.midX, y: tab.midY), with: nil))
        #expect(bar.point(inside: CGPoint(x: 20, y: tab.midY), with: nil) == false)
    }

    // Before the first layout pass there is no bar to aim at. A hit box derived from a zero
    // width would put a 44pt target in the screen's leading corner for one runloop turn.
    @Test func anUnlaidOutBarTakesNoTouches() {
        let bar = DesktopViewerTabBar(isExpanded: false)
        #expect(bar.point(inside: .zero, with: nil) == false)
        #expect(bar.point(inside: CGPoint(x: 14, y: 14), with: nil) == false)
    }
}
