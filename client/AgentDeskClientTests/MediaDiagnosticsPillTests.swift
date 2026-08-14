import Testing
import UIKit
@testable import AgentDeskClient

// The top-left media readout's disclosure. Small surface, but three of these are properties
// something else in the app already got wrong once, so they are pinned rather than assumed.
@MainActor
struct MediaDiagnosticsPillTests {
    @Test func itOpensInTheStateItWasBuiltWith() {
        #expect(MediaDiagnosticsPill(isExpanded: true).isExpanded)
        #expect(MediaDiagnosticsPill(isExpanded: false).isExpanded == false)
    }

    // Restoring a remembered disclosure must not write that same value straight back out.
    // The strips draw this line for the same reason: the layout owner also collapses them,
    // and only a deliberate tap is a preference.
    @Test func restoringADisclosureIsNotReportedAsAChoice() {
        let pill = MediaDiagnosticsPill(isExpanded: true)
        var reported: [Bool] = []
        pill.onDisclosureChange = { reported.append($0) }

        pill.setExpanded(false)
        pill.setExpanded(true)

        #expect(pill.isExpanded)
        #expect(reported.isEmpty)
    }

    // Setting the same state twice is not a change, so it neither re-lays-out nor reports.
    @Test func settingTheCurrentDisclosureIsANoOp() {
        let pill = MediaDiagnosticsPill(isExpanded: false)
        var reported: [Bool] = []
        pill.onDisclosureChange = { reported.append($0) }

        pill.setExpanded(false)

        #expect(pill.isExpanded == false)
        #expect(reported.isEmpty)
    }

    // The readout keeps arriving while hidden. If it did not, reopening the pill mid-run
    // would show whatever was last on screen before it was collapsed, which is the one thing
    // a diagnostics surface must never do.
    @Test func theReadoutStaysCurrentWhileCollapsed() {
        let pill = MediaDiagnosticsPill(isExpanded: false)
        pill.text = "30fps 2100kbps gap 16ms"
        #expect(pill.text == "30fps 2100kbps gap 16ms")

        pill.setExpanded(true)
        #expect(pill.text == "30fps 2100kbps gap 16ms")
    }

    // The glyph draws at 20pt, well under what a finger needs. The shortfall is made up
    // outside its box so it costs no pixels of the Mac, and this control is looked for
    // exactly when something is already going wrong.
    @Test func theGlyphIsStillAFingerWide() {
        let pill = MediaDiagnosticsPill(isExpanded: false)
        pill.frame = CGRect(x: 0, y: 0, width: 30, height: 30)

        #expect(pill.point(inside: CGPoint(x: 15, y: 15), with: nil))
        // Reachable across a full 44pt box centred on the 20pt glyph...
        #expect(pill.point(inside: CGPoint(x: -6, y: -6), with: nil))
        #expect(pill.point(inside: CGPoint(x: 36, y: 36), with: nil))
        // ...and no further, or it would start eating taps meant for the video behind it.
        #expect(pill.point(inside: CGPoint(x: -9, y: 15), with: nil) == false)
        #expect(pill.point(inside: CGPoint(x: 15, y: 39), with: nil) == false)
    }

    // The one that matters most. This replaced a UILabel, which had touch handling off, so
    // taps anywhere in that corner reached the Mac. Open, the pill is ~200pt wide; if all of
    // it took touches, the trackpad would silently lose a strip of the video across the top.
    @Test func tapsOnTheReadoutFallThroughToTheVideo() {
        let pill = MediaDiagnosticsPill(isExpanded: true)
        pill.frame = CGRect(x: 0, y: 0, width: 220, height: 30)

        #expect(pill.point(inside: CGPoint(x: 15, y: 15), with: nil))
        // Everything past the glyph's reach belongs to whatever is behind the pill.
        #expect(pill.point(inside: CGPoint(x: 60, y: 15), with: nil) == false)
        #expect(pill.point(inside: CGPoint(x: 180, y: 15), with: nil) == false)
        #expect(pill.point(inside: CGPoint(x: 219, y: 15), with: nil) == false)
    }

    // Before the first layout pass there is no glyph to aim at, and a hit box derived from a
    // zero height would be a 44pt target floating over the video for one runloop turn.
    @Test func anUnlaidOutPillTakesNoTouches() {
        let pill = MediaDiagnosticsPill(isExpanded: true)
        #expect(pill.point(inside: .zero, with: nil) == false)
        #expect(pill.point(inside: CGPoint(x: 15, y: 15), with: nil) == false)
    }
}
