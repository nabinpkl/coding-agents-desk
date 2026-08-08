import CoreGraphics
import Testing

@testable import AgentDeskHost

// The rule that decides how readable remote text is. Pinned here because it is a judgement
// call with a number attached: one captured pixel per phone pixel, which is the largest text
// achievable without the phone upscaling and blurring the glyphs.
@Suite("Window fit geometry")
struct WindowFitGeometryTests {
    // iPhone 17 Pro portrait, video viewport is the full width by 0.55 of the screen height.
    private let viewport = CGSize(width: 1206, height: 1443)
    // A 2x Mac display with the menu bar taken out.
    private let visibleFrame = CGRect(x: 0, y: 25, width: 1800, height: 1080)

    @Test("the window is sized so one captured pixel lands on one phone pixel")
    func theWindowIsSizedSoOneCapturedPixelLandsOnOnePhonePixel() {
        let outcome = WindowFitGeometry.fit(
            current: CGRect(x: 400, y: 300, width: 608, height: 465),
            viewportPixels: viewport,
            backingScale: 2,
            visibleFrame: visibleFrame
        )
        guard case .fit(let rect) = outcome else {
            Issue.record("expected a fit, got \(outcome)")
            return
        }
        #expect(rect.width == 603)
        #expect(rect.height == 721.5)
    }

    // Centring on the display instead would move every window to the same spot and make the
    // Mac unrecognisable while the phone drives it.
    @Test("the window keeps the centre the user left it at")
    func theWindowKeepsTheCentreTheUserLeftItAt() {
        let current = CGRect(x: 700, y: 400, width: 400, height: 300)
        guard case .fit(let rect) = WindowFitGeometry.fit(
            current: current,
            viewportPixels: viewport,
            backingScale: 2,
            visibleFrame: visibleFrame
        ) else {
            Issue.record("expected a fit")
            return
        }
        #expect(rect.midX == current.midX)
        #expect(rect.midY == current.midY)
    }

    @Test("a window near an edge is pushed back inside the display")
    func aWindowNearAnEdgeIsPushedBackInsideTheDisplay() {
        guard case .fit(let rect) = WindowFitGeometry.fit(
            current: CGRect(x: 1750, y: 1050, width: 200, height: 200),
            viewportPixels: viewport,
            backingScale: 2,
            visibleFrame: visibleFrame
        ) else {
            Issue.record("expected a fit")
            return
        }
        #expect(rect.maxX <= visibleFrame.maxX)
        #expect(rect.maxY <= visibleFrame.maxY)
        #expect(rect.minX >= visibleFrame.minX)
        #expect(rect.minY >= visibleFrame.minY)
    }

    // A resize costs a capture restart and a keyframe, so a window already the right size
    // must report unchanged rather than be set to the value it already holds.
    @Test("a window already the right size is left alone")
    func aWindowAlreadyTheRightSizeIsLeftAlone() {
        let fitted = CGRect(x: 500, y: 200, width: 603, height: 721.5)
        #expect(WindowFitGeometry.fit(
            current: fitted,
            viewportPixels: viewport,
            backingScale: 2,
            visibleFrame: visibleFrame
        ) == .unchanged)
    }

    // The phone's viewport can be taller in pixels than the Mac's usable height is in points
    // times its scale. Refusing would leave a letterboxed stream; scaling the request keeps
    // the aspect, which is what removes the letterbox.
    @Test("a viewport larger than the display scales down and keeps its aspect")
    func aViewportLargerThanTheDisplayScalesDownAndKeepsItsAspect() {
        let small = CGRect(x: 0, y: 25, width: 900, height: 600)
        guard case .fit(let rect) = WindowFitGeometry.fit(
            current: CGRect(x: 100, y: 100, width: 400, height: 300),
            viewportPixels: viewport,
            backingScale: 2,
            visibleFrame: small
        ) else {
            Issue.record("expected a fit")
            return
        }
        #expect(rect.width <= small.width)
        #expect(rect.height <= small.height)
        let wanted = viewport.width / viewport.height
        #expect(abs(rect.width / rect.height - wanted) < 0.001)
    }

    @Test("a fit with nothing to aim at is refused rather than guessed")
    func aFitWithNothingToAimAtIsRefusedRatherThanGuessed() {
        let current = CGRect(x: 0, y: 0, width: 400, height: 300)
        func reason(_ outcome: WindowFitGeometry.Outcome) -> String? {
            guard case .impossible(let reason) = outcome else { return nil }
            return reason
        }
        #expect(reason(WindowFitGeometry.fit(
            current: current, viewportPixels: .zero,
            backingScale: 2, visibleFrame: visibleFrame
        )) == "empty viewport")
        #expect(reason(WindowFitGeometry.fit(
            current: current, viewportPixels: viewport,
            backingScale: 0, visibleFrame: visibleFrame
        )) == "no backing scale")
        #expect(reason(WindowFitGeometry.fit(
            current: current, viewportPixels: viewport,
            backingScale: 2, visibleFrame: .zero
        )) == "empty display")
    }
}
