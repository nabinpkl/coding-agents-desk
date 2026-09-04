import XCTest
@testable import DeskZoom

final class ViewportTests: XCTestCase {
    private let canvas = CGSize(width: 7680, height: 4800)

    func testStartsFittingTheWholeCanvas() {
        let viewport = Viewport(canvas: canvas)
        XCTAssertEqual(viewport.visible, CGRect(origin: .zero, size: canvas))
        XCTAssertEqual(viewport.magnification, 1)
    }

    func testZoomKeepsAnchorFixedAndAspect() {
        var viewport = Viewport(canvas: canvas)
        let anchor = CGPoint(x: 1000, y: 3000)
        let fractionBefore = fraction(of: anchor, in: viewport)
        viewport.zoom(by: 2, anchor: anchor)
        XCTAssertEqual(viewport.visible.width, 3840, accuracy: 0.001)
        XCTAssertEqual(viewport.visible.height, 2400, accuracy: 0.001)
        let fractionAfter = fraction(of: anchor, in: viewport)
        XCTAssertEqual(fractionBefore.x, fractionAfter.x, accuracy: 0.0001)
        XCTAssertEqual(fractionBefore.y, fractionAfter.y, accuracy: 0.0001)
    }

    func testZoomOutNeverExceedsCanvas() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 0.5, anchor: CGPoint(x: 100, y: 100))
        XCTAssertEqual(viewport.visible, CGRect(origin: .zero, size: canvas))
    }

    func testZoomInStopsAtMinimumWidth() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 1000, anchor: CGPoint(x: 3840, y: 2400))
        XCTAssertEqual(viewport.visible.width, Viewport.minVisibleWidth)
        XCTAssertEqual(viewport.visible.height, Viewport.minVisibleWidth / 1.6, accuracy: 0.001)
    }

    func testZoomNearEdgeClampsInsideCanvas() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 4, anchor: CGPoint(x: 7680, y: 4800))
        XCTAssertEqual(viewport.visible.maxX, 7680, accuracy: 0.001)
        XCTAssertEqual(viewport.visible.maxY, 4800, accuracy: 0.001)
    }

    func testPanClampsInsideCanvas() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 2, anchor: .zero)
        viewport.pan(by: CGVector(dx: -500, dy: 100_000))
        XCTAssertEqual(viewport.visible.minX, 0)
        XCTAssertEqual(viewport.visible.maxY, 4800)
    }

    func testFitResetsAfterZoom() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 3, anchor: CGPoint(x: 500, y: 500))
        viewport.fit()
        XCTAssertEqual(viewport.visible, CGRect(origin: .zero, size: canvas))
    }

    func testCanvasPointMapsFractionInsideVisible() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 2, anchor: CGPoint(x: 3840, y: 2400))
        let point = viewport.canvasPoint(atFraction: CGPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(point.x, 3840, accuracy: 0.001)
        XCTAssertEqual(point.y, 2400, accuracy: 0.001)
    }

    private func fraction(of point: CGPoint, in viewport: Viewport) -> CGPoint {
        CGPoint(
            x: (point.x - viewport.visible.minX) / viewport.visible.width,
            y: (point.y - viewport.visible.minY) / viewport.visible.height
        )
    }
}

extension ViewportTests {
    func testZoomLimitsReportWhatTheButtonsCanDo() {
        var viewport = Viewport(canvas: CGSize(width: 7680, height: 4800))
        XCTAssertTrue(viewport.canZoomIn)
        XCTAssertFalse(viewport.canZoomOut, "fully fitted, there is nothing to zoom out to")

        viewport.zoom(by: 2, anchor: viewport.center)
        XCTAssertTrue(viewport.canZoomIn)
        XCTAssertTrue(viewport.canZoomOut)

        viewport.zoom(by: 1000, anchor: viewport.center)
        XCTAssertFalse(viewport.canZoomIn, "at the minimum visible width there is nothing to zoom into")
        XCTAssertTrue(viewport.canZoomOut)
    }

    func testCenterStaysPutWhenZoomingFromTheTitleBar() {
        var viewport = Viewport(canvas: CGSize(width: 7680, height: 4800))
        viewport.zoom(by: 4, anchor: CGPoint(x: 2000, y: 1500))
        let before = viewport.center
        viewport.zoom(by: 1.25, anchor: viewport.center)
        XCTAssertEqual(viewport.center.x, before.x, accuracy: 0.001)
        XCTAssertEqual(viewport.center.y, before.y, accuracy: 0.001)
    }
}

extension ViewportTests {


}

extension ViewportTests {
    func testFollowPansOnlyWhenTheCursorLeavesTheMargin() {
        var viewport = Viewport(canvas: CGSize(width: 7680, height: 4800))
        viewport.zoom(by: 2, anchor: CGPoint(x: 3840, y: 2400))
        let before = viewport.visible

        viewport.follow(viewport.center, margin: 0.2)
        XCTAssertEqual(viewport.visible, before, "a cursor in the middle needs no panning")

        let nearRightEdge = CGPoint(x: before.maxX - 1, y: before.midY)
        viewport.follow(nearRightEdge, margin: 0.2)
        XCTAssertGreaterThan(viewport.visible.minX, before.minX, "the view should chase the cursor right")
        XCTAssertLessThanOrEqual(viewport.visible.maxX, 7680)
    }

    func testFollowDoesNothingWhenTheWholeCanvasIsVisible() {
        var viewport = Viewport(canvas: CGSize(width: 7680, height: 4800))
        viewport.follow(CGPoint(x: 0, y: 0), margin: 0.2)
        XCTAssertEqual(viewport.visible, CGRect(x: 0, y: 0, width: 7680, height: 4800))
    }

    func testFollowKeepsTheCursorInsideAfterPanning() {
        var viewport = Viewport(canvas: CGSize(width: 7680, height: 4800))
        viewport.zoom(by: 3, anchor: CGPoint(x: 3840, y: 2400))
        let target = CGPoint(x: viewport.visible.maxX + 400, y: viewport.visible.minY - 300)
        viewport.follow(target, margin: 0.18)
        XCTAssertTrue(viewport.visible.contains(target), "the cursor must end up on screen")
    }

    func testCaptureRegionPadsWhenZoomedAndStaysInsideTheCanvas() {
        var viewport = Viewport(canvas: CGSize(width: 7680, height: 4800))
        XCTAssertEqual(viewport.captureRegion(padding: 0.1), CGRect(x: 0, y: 0, width: 7680, height: 4800))

        viewport.zoom(by: 4, anchor: CGPoint(x: 3840, y: 2400))
        let region = viewport.captureRegion(padding: 0.1)
        XCTAssertGreaterThan(region.width, viewport.visible.width)
        XCTAssertTrue(region.contains(viewport.visible))
        XCTAssertGreaterThanOrEqual(region.minX, 0)
        XCTAssertLessThanOrEqual(region.maxX, 7680)
    }
}

final class CapturePlanTests: XCTestCase {
    private let region = CGRect(x: 1000, y: 500, width: 4000, height: 2500)

    private func plan(pixelsPerPoint: CGFloat) -> CapturePlan {
        CapturePlan(region: region, pixelSize: CGSize(width: region.width * pixelsPerPoint, height: region.height * pixelsPerPoint))
    }

    func testAPanInsideTheCapturedRegionNeedsNoNewStream() {
        let inside = CGRect(x: 1200, y: 700, width: 3000, height: 1875)
        XCTAssertTrue(plan(pixelsPerPoint: 0.5).satisfies(visible: inside, pixelsPerPoint: 0.5, tolerance: 0.35))
    }

    func testPanningOutOfTheCapturedRegionNeedsANewStream() {
        let outside = CGRect(x: 4500, y: 700, width: 3000, height: 1875)
        XCTAssertFalse(plan(pixelsPerPoint: 0.5).satisfies(visible: outside, pixelsPerPoint: 0.5, tolerance: 0.35))
    }

    func testTooFewPixelsForTheWantedDetailNeedsANewStream() {
        let inside = CGRect(x: 1200, y: 700, width: 1000, height: 625)
        XCTAssertFalse(plan(pixelsPerPoint: 0.2).satisfies(visible: inside, pixelsPerPoint: 1, tolerance: 0.35))
    }

    func testFarTooManyPixelsAlsoNeedsANewStream() {
        let inside = CGRect(x: 1200, y: 700, width: 3000, height: 1875)
        XCTAssertFalse(plan(pixelsPerPoint: 1).satisfies(visible: inside, pixelsPerPoint: 0.2, tolerance: 0.35))
    }

    func testASmallDetailChangeIsToleratedWithoutRestarting() {
        let inside = CGRect(x: 1200, y: 700, width: 3000, height: 1875)
        XCTAssertTrue(plan(pixelsPerPoint: 0.5).satisfies(visible: inside, pixelsPerPoint: 0.6, tolerance: 0.35))
    }
}

final class CanvasFocusTests: XCTestCase {
    private func window(_ pid: pid_t, _ layer: Int, _ frame: CGRect) -> CanvasFocus.Window {
        CanvasFocus.Window(pid: pid, layer: layer, frame: frame)
    }

    func testPicksTheFrontmostOrdinaryWindowUnderThePoint() {
        let windows = [
            window(11, 0, CGRect(x: 2000, y: 500, width: 800, height: 600)),
            window(22, 0, CGRect(x: 1900, y: 400, width: 2000, height: 1500)),
        ]
        XCTAssertEqual(CanvasFocus.topmostOwner(at: CGPoint(x: 2100, y: 600), in: windows, excluding: 99), 11)
        XCTAssertEqual(CanvasFocus.topmostOwner(at: CGPoint(x: 3500, y: 1500), in: windows, excluding: 99), 22)
    }

    func testIgnoresNonApplicationLayers() {
        // The Dock, menu bar, overlays and wallpaper all cover the point but must never take focus.
        let windows = [
            window(11, 25, CGRect(x: 1800, y: 0, width: 7680, height: 4800)),
            window(22, -2_147_483_603, CGRect(x: 1800, y: 0, width: 7680, height: 4800)),
            window(33, 0, CGRect(x: 2000, y: 500, width: 800, height: 600)),
        ]
        XCTAssertEqual(CanvasFocus.topmostOwner(at: CGPoint(x: 2100, y: 600), in: windows, excluding: 99), 33)
    }

    func testBareDesktopHasNoOwner() {
        let windows = [window(11, 0, CGRect(x: 2000, y: 500, width: 800, height: 600))]
        XCTAssertNil(CanvasFocus.topmostOwner(at: CGPoint(x: 6000, y: 3000), in: windows, excluding: 99))
    }

    func testNeverPicksDeskZoomItself() {
        let windows = [window(42, 0, CGRect(x: 2000, y: 500, width: 800, height: 600))]
        XCTAssertNil(CanvasFocus.topmostOwner(at: CGPoint(x: 2100, y: 600), in: windows, excluding: 42))
    }
}
