import Foundation

enum TouchScrollMode: String, CaseIterable, Equatable {
    case off
    case asIs
    case full
}

func persistedTouchScrollMode(fromStoredValue value: Any?) -> TouchScrollMode {
    if let raw = value as? String {
        return TouchScrollMode(rawValue: raw) ?? .off
    }
    if let enabled = value as? Bool {
        return enabled ? .asIs : .off
    }
    return .off
}

func toggledTouchScrollMode(current: TouchScrollMode, selected: TouchScrollMode) -> TouchScrollMode {
    guard selected == .full || selected == .asIs else { return .off }
    return current == selected ? .off : selected
}

// Finger-count gesture routing for touch-scroll mode, as a pure value so the
// UIKit apply step (applyTouchScrollMode) stays a trivial translator and the
// routing is unit-testable without a view controller. Mirrors the
// ControlSurface.visibility(for:) seam. Design:
// docs/superpowers/specs/2026-07-03-touch-scroll-pinch-zoom-design.md
//
// One finger scrolls the host at any zoom level; two fingers behave as
// touch-mode-off (native UIScrollView pinch + pan-while-pinched). The scroll
// view stays zoom-capable in both modes (scrollViewScrollEnabled always true) —
// setting isScrollEnabled = false would also disable pinch. Routing is by the
// scroll view pan's minimum touch count: 2 in touch mode (one finger never pans
// the local view, leaving single-finger drags to the touch-scroll recognizer),
// 1 otherwise (default).
struct TouchScrollGestureConfig: Equatable {
    let touchScrollRecognizerEnabled: Bool
    let scrollViewScrollEnabled: Bool
    let scrollViewPanMinimumTouches: Int
    let relativeControlsHidden: Bool
    let relativeControlsAlpha: Double
    let relativeControlsInteractionEnabled: Bool
    let usesFullLayout: Bool
}

func touchScrollGestureConfig(touchScrollMode mode: TouchScrollMode) -> TouchScrollGestureConfig {
    let on = mode != .off
    let full = mode == .full
    return TouchScrollGestureConfig(
        touchScrollRecognizerEnabled: on,
        scrollViewScrollEnabled: true,
        scrollViewPanMinimumTouches: on ? 2 : 1,
        relativeControlsHidden: full,
        relativeControlsAlpha: 1.0,
        relativeControlsInteractionEnabled: !full,
        usesFullLayout: full
    )
}
