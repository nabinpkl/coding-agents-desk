import Testing
import UIKit

// The stacking bands inside the host content root. Pure ordering, so no view
// controller is required -- the same testable-seam shape as ControlSurface.
struct HostContentStageTests {
    // `installHostContentStages` mounts in `allCases` order and everything else
    // reasons in `<`, so the two have to agree. They do as long as nobody hands
    // out explicit raw values in a different order from the declarations.
    @Test func casesAreDeclaredBackToFront() {
        #expect(HostContentStage.allCases == HostContentStage.allCases.sorted())
    }

    // Where a surface is on screen, it is what you see: the Mac's pixels and the
    // controls that drive them are both behind it. (Where a surface is NOT --
    // the band above the safe-area top -- no ordering helps, which is why the
    // video stops being drawn instead. See `VideoDemand`.)
    @Test func aSurfaceCoversBothTheMacVideoAndTheMacControls() {
        #expect(HostContentStage.surface > .backdrop)
        #expect(HostContentStage.surface > .chrome)
    }

    // The host-status overlay is the escape hatch for a session the client thinks
    // is alive and is not. It is worth nothing if a surface can cover it.
    @Test func theEscapeHatchBandSitsOverEverything() {
        for band in HostContentStage.allCases where band != .overlay {
            #expect(HostContentStage.overlay > band)
        }
    }

    @Test func everyBandHasItsOwnIdentifier() {
        let identifiers = HostContentStage.allCases.map(\.accessibilityIdentifier)
        #expect(Set(identifiers).count == HostContentStage.allCases.count)
        identifiers.forEach { #expect($0.hasPrefix("host-stage-")) }
    }
}

// The bands are full-bleed and stacked on each other, so this is what stands
// between "named z-order" and "the top band eats every touch in the app".
@MainActor
struct PassthroughViewTests {
    private func band() -> PassthroughView {
        PassthroughView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    }

    @Test func aPointClaimedByNoSubviewFallsThroughToTheBandBelow() {
        #expect(band().hitTest(CGPoint(x: 50, y: 50), with: nil) == nil)
    }

    @Test func aPointOnASubviewStillLandsOnThatSubview() {
        let container = band()
        let child = UIView(frame: CGRect(x: 0, y: 0, width: 50, height: 50))
        container.addSubview(child)
        #expect(container.hitTest(CGPoint(x: 10, y: 10), with: nil) === child)
    }

    // A band whose contents are all hidden -- every non-active surface band, most
    // of the time -- has to be completely transparent to touches, with no extra
    // bookkeeping at the mount sites.
    @Test func aHiddenSubviewDoesNotHoldTheBandOpen() {
        let container = band()
        let child = UIView(frame: CGRect(x: 0, y: 0, width: 50, height: 50))
        child.isHidden = true
        container.addSubview(child)
        #expect(container.hitTest(CGPoint(x: 10, y: 10), with: nil) == nil)
    }
}
