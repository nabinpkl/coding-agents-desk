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
        XCTAssertTrue(plan(pixelsPerPoint: 0.5).satisfies(visible: inside, pixelsPerPoint: 0.5, shortfall: 0.92, surplus: 2.2))
    }

    func testPanningOutOfTheCapturedRegionNeedsANewStream() {
        let outside = CGRect(x: 4500, y: 700, width: 3000, height: 1875)
        XCTAssertFalse(plan(pixelsPerPoint: 0.5).satisfies(visible: outside, pixelsPerPoint: 0.5, shortfall: 0.92, surplus: 2.2))
    }

    func testTooFewPixelsForTheWantedDetailNeedsANewStream() {
        let inside = CGRect(x: 1200, y: 700, width: 1000, height: 625)
        XCTAssertFalse(plan(pixelsPerPoint: 0.2).satisfies(visible: inside, pixelsPerPoint: 1, shortfall: 0.92, surplus: 2.2))
    }

    func testFarTooManyPixelsAlsoNeedsANewStream() {
        let inside = CGRect(x: 1200, y: 700, width: 3000, height: 1875)
        XCTAssertFalse(plan(pixelsPerPoint: 1).satisfies(visible: inside, pixelsPerPoint: 0.2, shortfall: 0.92, surplus: 2.2))
    }

    func testASpareOfPixelsIsToleratedButAShortfallIsNot() {
        let inside = CGRect(x: 1200, y: 700, width: 3000, height: 1875)
        // Twice the pixels needed only wastes work, so it keeps the stream it has.
        XCTAssertTrue(plan(pixelsPerPoint: 1).satisfies(visible: inside, pixelsPerPoint: 0.5, shortfall: 0.92, surplus: 2.2))
        // A tenth short is visibly softer text, so it re-aims.
        XCTAssertFalse(plan(pixelsPerPoint: 0.9).satisfies(visible: inside, pixelsPerPoint: 1, shortfall: 0.92, surplus: 2.2))
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

final class ViewportStoreTests: XCTestCase {
    private let canvas = CGSize(width: 7680, height: 4800)

    func testARememberedViewSurvivesTheRoundTrip() {
        var viewport = Viewport(canvas: canvas)
        viewport.zoom(by: 4, anchor: CGPoint(x: 2000, y: 1500))
        let restored = ViewportStore.decode(ViewportStore.encode(viewport), canvas: canvas)
        XCTAssertEqual(restored, viewport.visible)
    }

    func testAViewStoredForAnotherCanvasIsIgnored() {
        let viewport = Viewport(canvas: CGSize(width: 5120, height: 3200))
        XCTAssertNil(ViewportStore.decode(ViewportStore.encode(viewport), canvas: canvas))
    }

    func testNonsenseIsIgnored() {
        XCTAssertNil(ViewportStore.decode(nil, canvas: canvas))
        XCTAssertNil(ViewportStore.decode([7680, 4800, 0, 0], canvas: canvas))
        XCTAssertNil(ViewportStore.decode([7680, 4800, 0, 0, 20, 12], canvas: canvas), "narrower than the zoom limit")
        XCTAssertNil(ViewportStore.decode([7680, 4800, 7000, 0, 4000, 2500], canvas: canvas), "runs off the canvas")
    }

    func testRestoringClampsAViewThatNoLongerFits() {
        let viewport = Viewport(canvas: canvas, restoring: CGRect(x: 7000, y: 4000, width: 4000, height: 2500))
        XCTAssertLessThanOrEqual(viewport.visible.maxX, canvas.width)
        XCTAssertLessThanOrEqual(viewport.visible.maxY, canvas.height)
        XCTAssertEqual(viewport.visible.width / viewport.visible.height, canvas.width / canvas.height, accuracy: 0.001)
    }
}

final class VirtualDisplayLadderTests: XCTestCase {
    func testDeclaredSizesIncludeHalvesSoMacOSCanPairThemIntoHiDPI() {
        let sizes = VirtualDisplay.declaredPixelSizes(maxWidth: 7680, maxHeight: 4800)
        XCTAssertTrue(sizes.contains(CGSize(width: 7680, height: 4800)))
        XCTAssertTrue(sizes.contains(CGSize(width: 3840, height: 2400)), "the half of the largest, so it can be paired")
        XCTAssertTrue(sizes.allSatisfy { $0.width <= 7680 }, "nothing may exceed the framebuffer asked for")
        XCTAssertEqual(sizes, sizes.sorted { $0.width < $1.width })
    }

    func testTheLadderKeepsTheSharpestModeAndDropsWhatIsNotADesk() {
        let rungs = [
            VirtualDisplay.Rung(width: 1024, height: 640, pixelWidth: 1024),   // too small
            VirtualDisplay.Rung(width: 2560, height: 1920, pixelWidth: 2560),  // 4:3, wrong shape
            VirtualDisplay.Rung(width: 3840, height: 2400, pixelWidth: 3840),  // same canvas, less detail
            VirtualDisplay.Rung(width: 3840, height: 2400, pixelWidth: 7680),  // same canvas, more detail
            VirtualDisplay.Rung(width: 7680, height: 4800, pixelWidth: 7680),
        ]
        let ladder = VirtualDisplay.ladder(from: rungs, aspect: 1.6, minimumWidth: 1920)
        XCTAssertEqual(ladder.count, 2)
        XCTAssertEqual(ladder.first?.size.width, 3840)
        XCTAssertEqual(ladder.first?.pixelsPerPoint, 2, "the sharper of two modes for the same canvas wins")
        XCTAssertEqual(ladder.last?.size.width, 7680)
        XCTAssertEqual(ladder.last?.pixelsPerPoint, 1)
    }

    func testACanvasLabelSaysBothSizeAndSharpness() {
        let sharp = VirtualDisplay.Canvas(size: CGSize(width: 3840, height: 2400), pixelsPerPoint: 2)
        let wide = VirtualDisplay.Canvas(size: CGSize(width: 7680, height: 4800), pixelsPerPoint: 1)
        XCTAssertEqual(sharp.label, "3840×2400 @2x")
        XCTAssertEqual(wide.label, "7680×4800 @1x")
    }
}

final class OverviewCaptureTests: XCTestCase {
    func testASmallCanvasIsCapturedWholeAtFullDetail() {
        // 1920x1200 at 2x is 3840x2400 pixels, comfortably inside the budget, so nothing is given up.
        let size = CanvasView.overviewPixelSize(for: CGSize(width: 1920, height: 1200), pixelsPerPoint: 2)
        XCTAssertEqual(size, CGSize(width: 3840, height: 2400))
    }

    func testALargeCanvasIsCapturedWholeWithinTheBudget() {
        let canvas = CGSize(width: 7680, height: 4800)
        let size = CanvasView.overviewPixelSize(for: canvas, pixelsPerPoint: 1)
        XCTAssertLessThanOrEqual(size.width * size.height, CanvasView.overviewPixelBudget * 1.001)
        XCTAssertEqual(size.width / size.height, canvas.width / canvas.height, accuracy: 0.01)
        XCTAssertGreaterThan(size.width, canvas.width / 3, "still far more detail than a thumbnail")
    }

    func testTheOverviewIsNeverAskedForMoreThanTheDisplayHolds() {
        let size = CanvasView.overviewPixelSize(for: CGSize(width: 1280, height: 800), pixelsPerPoint: 1)
        XCTAssertEqual(size, CGSize(width: 1280, height: 800))
    }
}

extension OverviewCaptureTests {
    func testTheSharpRungsAreCoveredWholeByTheOverview() {
        // No second stream is needed on these, so panning them cannot flicker.
        for canvas in [CGSize(width: 1920, height: 1200), CGSize(width: 2560, height: 1600)] {
            let size = CanvasView.overviewPixelSize(for: canvas, pixelsPerPoint: 2)
            XCTAssertEqual(size.width / canvas.width, 2, accuracy: 0.001, "\(canvas) should be captured at full detail")
        }
        let wide = CGSize(width: 5120, height: 3200)
        XCTAssertEqual(CanvasView.overviewPixelSize(for: wide, pixelsPerPoint: 1).width / wide.width, 1, accuracy: 0.001)
    }
}

final class ControlCommandTests: XCTestCase {
    func testParsesTheCommandsAScriptSends() {
        XCTAssertEqual(ControlCommand.parse("move 1200 800"), .move(CGPoint(x: 1200, y: 800)))
        XCTAssertEqual(ControlCommand.parse("move-fraction 0.5 0.25"), .moveFraction(CGPoint(x: 0.5, y: 0.25)))
        XCTAssertEqual(ControlCommand.parse("press"), .press)
        XCTAssertEqual(ControlCommand.parse("describe"), .describe)
        XCTAssertEqual(ControlCommand.parse("status"), .status)
        XCTAssertEqual(ControlCommand.parse("hide"), .hide)
    }

    func testToleratesTheShapeOfRealShellInput() {
        XCTAssertEqual(ControlCommand.parse("  MOVE   1200   800  "), .move(CGPoint(x: 1200, y: 800)))
        XCTAssertEqual(ControlCommand.parse("move 1200.5 800.25"), .move(CGPoint(x: 1200.5, y: 800.25)))
    }

    func testRefusesWhatItCannotActOn() {
        XCTAssertNil(ControlCommand.parse(""))
        XCTAssertNil(ControlCommand.parse("move"), "a move without a point would aim at nothing")
        XCTAssertNil(ControlCommand.parse("move 1200"))
        XCTAssertNil(ControlCommand.parse("move left right"))
        XCTAssertNil(ControlCommand.parse("click 10 20"))
    }
}

extension ControlCommandTests {
    func testParsesWindowAndScrollCommands() {
        XCTAssertEqual(ControlCommand.parse("windows"), .windows)
        XCTAssertEqual(ControlCommand.parse("move-window 2"), .moveWindow(2))
        XCTAssertEqual(ControlCommand.parse("scroll 0.4"), .scroll(.vertical, 0.4))
        XCTAssertEqual(ControlCommand.parse("scroll-by -0.1"), .scrollBy(.vertical, -0.1))
        XCTAssertEqual(ControlCommand.parse("scroll-x 1"), .scroll(.horizontal, 1))
        XCTAssertEqual(ControlCommand.parse("scroll-x-by 0.25"), .scrollBy(.horizontal, 0.25))
        XCTAssertNil(ControlCommand.parse("scroll"), "a scroll with no target is meaningless")
        XCTAssertNil(ControlCommand.parse("move-window"), "a window move needs to say which")
    }
}

final class CanvasWindowListTests: XCTestCase {
    private let display = CGRect(x: 1800, y: 0, width: 2560, height: 1600)

    private func window(_ owner: String, layer: Int = 0, _ frame: CGRect) -> CanvasFocus.Window {
        CanvasFocus.Window(pid: 1, layer: layer, frame: frame, owner: owner, title: "")
    }

    func testKeepsOrdinaryWindowsOnTheDisplayInDisplayCoordinates() {
        let listed = CanvasFocus.onDisplay([
            window("TextEdit", CGRect(x: 2200, y: 400, width: 1000, height: 700)),
            window("Finder", CGRect(x: 100, y: 100, width: 800, height: 600)),      // on the built-in screen
            window("Dock", layer: 20, CGRect(x: 1800, y: 0, width: 2560, height: 1600)),
            window("Overlay", layer: 2_147_483_629, CGRect(x: 1800, y: 0, width: 2560, height: 1600)),
        ], bounds: display)
        XCTAssertEqual(listed.map(\.owner), ["TextEdit"])
        XCTAssertEqual(listed.first?.frame, CGRect(x: 400, y: 400, width: 1000, height: 700), "moved into the display's own coordinates")
    }

    func testAWindowStraddlingTheEdgeStillCounts() {
        let listed = CanvasFocus.onDisplay([window("Calculator", CGRect(x: 1700, y: 300, width: 300, height: 400))], bounds: display)
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed.first?.frame.minX, -100)
    }
}

extension ControlCommandTests {
    func testTypeKeepsTheLineAsWritten() {
        XCTAssertEqual(ControlCommand.parse("type hello world"), .type("hello world"))
        XCTAssertEqual(ControlCommand.parse("type two  spaces"), .type("two  spaces"))
        XCTAssertEqual(ControlCommand.parse("type 1 2"), .type("1 2"), "numbers are text here, not arguments")
        XCTAssertNil(ControlCommand.parse("type"), "nothing to type")
        XCTAssertNil(ControlCommand.parse("type   "))
    }

    func testActivateAndShot() {
        XCTAssertEqual(ControlCommand.parse("activate"), .activate)
        XCTAssertEqual(ControlCommand.parse("shot 2"), .shot(2, nil))
        XCTAssertEqual(ControlCommand.parse("shot 0 /tmp/win.png"), .shot(0, "/tmp/win.png"))
        XCTAssertNil(ControlCommand.parse("shot"), "which window?")
        XCTAssertNil(ControlCommand.parse("shot two"))
    }

    func testKeyTakesOneChord() {
        XCTAssertEqual(ControlCommand.parse("key cmd+a"), .key(KeyChord(keyCode: 0, flags: .maskCommand)))
        XCTAssertEqual(ControlCommand.parse("help"), .help)
        XCTAssertNil(ControlCommand.parse("key"), "which key?")
        XCTAssertNil(ControlCommand.parse("key return tab"), "one key per command; type handles sequences")
        XCTAssertNil(ControlCommand.parse("key hyper+a"))
    }
}

final class KeyChordTests: XCTestCase {
    func testNamesTheKeysAScriptReachesFor() {
        XCTAssertEqual(KeyChord.parse("return"), KeyChord(keyCode: 36, flags: []))
        XCTAssertEqual(KeyChord.parse("Return"), KeyChord(keyCode: 36, flags: []), "case is not meaning")
        XCTAssertEqual(KeyChord.parse("tab"), KeyChord(keyCode: 48, flags: []))
        XCTAssertEqual(KeyChord.parse("cmd+a"), KeyChord(keyCode: 0, flags: .maskCommand))
        XCTAssertEqual(KeyChord.parse("cmd+shift+z"), KeyChord(keyCode: 6, flags: [.maskCommand, .maskShift]))
        XCTAssertEqual(KeyChord.parse("option+left"), KeyChord(keyCode: 123, flags: .maskAlternate))
        XCTAssertEqual(KeyChord.parse("cmd+shift+period"), KeyChord(keyCode: 47, flags: [.maskCommand, .maskShift]),
                       "punctuation is named, since + is the chord separator")
    }

    func testRefusesWhatItCannotSend() {
        XCTAssertNil(KeyChord.parse(""))
        XCTAssertNil(KeyChord.parse("cmd+"), "a modifier alone presses nothing")
        XCTAssertNil(KeyChord.parse("hyper+a"))
        XCTAssertNil(KeyChord.parse("é"), "characters go through type, which carries them as text")
    }
}
