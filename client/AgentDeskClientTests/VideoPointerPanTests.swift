import Testing
import CoreGraphics
@testable import AgentDeskClient

// Pointer mode's mapping from finger travel to pointer travel. The property under test
// throughout is the same one: one screen point of finger is one screen point of pointer,
// whatever the zoom. That is what makes zooming in buy precision instead of just size.
struct VideoPointerPanTests {
    // A 1512pt-wide display shown in a 756pt-wide picture: two host points per screen point.
    private static let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private static let video = CGSize(width: 756, height: 491)

    private static func delta(_ finger: CGPoint, zoom: CGFloat = 1.0) -> CGPoint? {
        VideoPointerPan.hostDelta(
            fingerDelta: finger,
            videoSize: video,
            displayBounds: display,
            zoomScale: zoom
        )
    }

    @Test func fingerTravelScalesUpByHowMuchTheDisplayWasShrunkToFit() {
        // The picture is half the display's width, so a 10pt finger crosses 20 host points.
        #expect(Self.delta(CGPoint(x: 10, y: 10)) == CGPoint(x: 20, y: 20))
    }

    // The reason this is not the trackpad's `emitCursorDelta`, which knows nothing about zoom
    // and would move the pointer at twice the visual rate of the finger at 2x.
    @Test func zoomingInMakesTheSameFingerTravelMoveThePointerLess() {
        #expect(Self.delta(CGPoint(x: 10, y: 10), zoom: 2.0) == CGPoint(x: 10, y: 10))
        #expect(Self.delta(CGPoint(x: 10, y: 10), zoom: 4.0) == CGPoint(x: 5, y: 5))
    }

    // Non-square scaling has to be per-axis, or a diagonal drag bends. Displays and pictures
    // agree on aspect today, but nothing in the type system says they must.
    @Test func eachAxisScalesByItsOwnRatio() {
        let squashed = VideoPointerPan.hostDelta(
            fingerDelta: CGPoint(x: 10, y: 10),
            videoSize: CGSize(width: 756, height: 982),
            displayBounds: Self.display,
            zoomScale: 1.0
        )
        #expect(squashed == CGPoint(x: 20, y: 10))
    }

    @Test func directionIsPreserved() {
        #expect(Self.delta(CGPoint(x: -10, y: -10)) == CGPoint(x: -20, y: -20))
    }

    // Unknown geometry is not a scale of 1. Substituting one would move the pointer by a
    // wrong amount, which is worse than not moving it: the caller can send nothing, but it
    // cannot take back a frame the host already applied.
    @Test func unknownGeometryYieldsNothingRatherThanAGuess() {
        #expect(VideoPointerPan.hostDelta(
            fingerDelta: CGPoint(x: 10, y: 10),
            videoSize: .zero,
            displayBounds: Self.display,
            zoomScale: 1.0
        ) == nil)
        #expect(VideoPointerPan.hostDelta(
            fingerDelta: CGPoint(x: 10, y: 10),
            videoSize: Self.video,
            displayBounds: .zero,
            zoomScale: 1.0
        ) == nil)
        #expect(Self.delta(CGPoint(x: 10, y: 10), zoom: 0) == nil)
    }

    @Test func aNonFiniteFingerDeltaIsRejected() {
        #expect(Self.delta(CGPoint(x: CGFloat.nan, y: 0)) == nil)
        #expect(Self.delta(CGPoint(x: CGFloat.infinity, y: 0)) == nil)
    }
}
