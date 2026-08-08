import CoreGraphics

// Where a watched window goes when the phone asks for a fit.
//
// Pure geometry, no Accessibility and no live window, so the rule that decides how readable
// remote text is can be asserted directly.
//
// The rule is one captured pixel per phone pixel. Text on the phone gets bigger as the
// window gets smaller, because a smaller window means the phone's fixed viewport shows fewer
// Mac points -- but past the point where the window stops having as many pixels as the
// viewport, the phone upscales, which blurs exactly the small glyphs being read, and HEVC at
// a pinned bitrate makes that worse. Matching pixels is the largest text achievable with no
// resampling. It also encodes far fewer pixels than a maximized window, so the pinned
// bitrate goes further per pixel.
enum WindowFitGeometry {
    // Result of asking for a fit. `.unchanged` matters: a window already the right size must
    // not be resized, because a resize costs a capture restart and a keyframe.
    enum Outcome: Equatable {
        case fit(CGRect)
        case unchanged
        case impossible(reason: String)
    }

    static func fit(
        current: CGRect,
        viewportPixels: CGSize,
        backingScale: CGFloat,
        visibleFrame: CGRect
    ) -> Outcome {
        guard viewportPixels.width > 0, viewportPixels.height > 0 else {
            return .impossible(reason: "empty viewport")
        }
        guard backingScale > 0 else { return .impossible(reason: "no backing scale") }
        guard visibleFrame.width > 0, visibleFrame.height > 0 else {
            return .impossible(reason: "empty display")
        }

        // Points the window needs so that its captured pixels equal the viewport's.
        var width = viewportPixels.width / backingScale
        var height = viewportPixels.height / backingScale

        // A viewport larger than the Mac's own usable area cannot be matched. Scale the
        // request down rather than refuse it: keeping the aspect still removes the letterbox
        // and the residual upscale is smaller than any other option would give.
        let overflow = max(width / visibleFrame.width, height / visibleFrame.height, 1)
        width /= overflow
        height /= overflow

        // Keep the window's centre where the user left it, then push it back inside the
        // display. Centring on the display instead would move every window to the same place
        // and make the Mac unrecognisable while the phone drives it.
        let centre = CGPoint(x: current.midX, y: current.midY)
        var origin = CGPoint(x: centre.x - width / 2, y: centre.y - height / 2)
        origin.x = min(max(origin.x, visibleFrame.minX), visibleFrame.maxX - width)
        origin.y = min(max(origin.y, visibleFrame.minY), visibleFrame.maxY - height)

        let target = CGRect(x: origin.x, y: origin.y, width: width, height: height)
        // Sub-point differences are noise from the divisions above, not a resize anyone
        // asked for, and acting on them would restart the capture for nothing.
        if abs(target.width - current.width) < 1,
           abs(target.height - current.height) < 1,
           abs(target.origin.x - current.origin.x) < 1,
           abs(target.origin.y - current.origin.y) < 1 {
            return .unchanged
        }
        return .fit(target)
    }
}
