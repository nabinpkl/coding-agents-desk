import Foundation

enum TouchScrollLayoutMode: String, CaseIterable, Equatable {
    case asIs
    case full
}

struct TouchScrollControlState: Equatable {
    var layoutMode: TouchScrollLayoutMode
    var touchScrollEnabled: Bool

    func with(layoutMode newLayoutMode: TouchScrollLayoutMode) -> TouchScrollControlState {
        TouchScrollControlState(layoutMode: newLayoutMode, touchScrollEnabled: touchScrollEnabled)
    }

    func with(touchScrollEnabled newTouchScrollEnabled: Bool) -> TouchScrollControlState {
        TouchScrollControlState(layoutMode: layoutMode, touchScrollEnabled: newTouchScrollEnabled)
    }
}

// Finger-count gesture routing for touch-scroll input, as a pure value so the
// UIKit apply step (applyTouchScrollState) stays a trivial translator and the
// routing is unit-testable without a view controller. Mirrors the
// ControlSurface.visibility(for:) seam. Design:
// docs/superpowers/specs/2026-07-03-touch-scroll-pinch-zoom-design.md
//
// When touch scroll is on, one finger scrolls the host at any zoom level and
// two fingers behave as native UIScrollView pinch + pan-while-pinched. Full
// layout is independent: it hides the relative controls and expands the video
// without forcing touch-scroll input routing.
struct TouchScrollGestureConfig: Equatable {
    let touchScrollRecognizerEnabled: Bool
    let scrollViewScrollEnabled: Bool
    let scrollViewPanMinimumTouches: Int
    let relativeControlsHidden: Bool
    let relativeControlsAlpha: Double
    let relativeControlsInteractionEnabled: Bool
    let usesFullLayout: Bool
}

func touchScrollGestureConfig(
    touchScrollEnabled: Bool,
    layoutMode: TouchScrollLayoutMode
) -> TouchScrollGestureConfig {
    let full = layoutMode == .full
    return TouchScrollGestureConfig(
        touchScrollRecognizerEnabled: touchScrollEnabled,
        scrollViewScrollEnabled: true,
        scrollViewPanMinimumTouches: touchScrollEnabled ? 2 : 1,
        relativeControlsHidden: full,
        relativeControlsAlpha: 1.0,
        relativeControlsInteractionEnabled: !full,
        usesFullLayout: full
    )
}
