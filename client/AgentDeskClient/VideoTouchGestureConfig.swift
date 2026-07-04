import Foundation
import AgentDeskWire

enum VideoLayoutMode: String, CaseIterable, Equatable {
    case asIs
    case full
}

struct VideoTouchControlState: Equatable {
    var layoutMode: VideoLayoutMode
    var videoTouchEnabled: Bool

    func with(layoutMode newLayoutMode: VideoLayoutMode) -> VideoTouchControlState {
        VideoTouchControlState(layoutMode: newLayoutMode, videoTouchEnabled: videoTouchEnabled)
    }

    func with(videoTouchEnabled newVideoTouchEnabled: Bool) -> VideoTouchControlState {
        VideoTouchControlState(layoutMode: layoutMode, videoTouchEnabled: newVideoTouchEnabled)
    }
}

// Finger-count gesture routing for video touch input, as a pure value so the
// UIKit apply step (applyVideoTouchState) stays a trivial translator and the
// routing is unit-testable without a view controller. Mirrors the
// ControlSurface.visibility(for:) pattern. Design:
// docs/superpowers/specs/2026-07-03-touch-scroll-pinch-zoom-design.md
//
// When video touch is on, one finger taps/clicks or scrolls the host at any
// zoom level and two fingers behave as native UIScrollView pinch +
// pan-while-pinched. Full layout is independent: it hides the relative controls
// and expands the video without forcing video touch input routing.
struct VideoTouchGestureConfig: Equatable {
    let videoTouchTapRecognizerEnabled: Bool
    let videoTouchScrollRecognizerEnabled: Bool
    let doubleTapZoomRecognizerEnabled: Bool
    let scrollViewScrollEnabled: Bool
    let scrollViewPanMinimumTouches: Int
    let relativeControlsHidden: Bool
    let relativeControlsAlpha: Double
    let relativeControlsInteractionEnabled: Bool
    let usesFullLayout: Bool
}

func videoTouchGestureConfig(
    videoTouchEnabled: Bool,
    layoutMode: VideoLayoutMode
) -> VideoTouchGestureConfig {
    let full = layoutMode == .full
    return VideoTouchGestureConfig(
        videoTouchTapRecognizerEnabled: videoTouchEnabled,
        videoTouchScrollRecognizerEnabled: videoTouchEnabled,
        doubleTapZoomRecognizerEnabled: !videoTouchEnabled,
        scrollViewScrollEnabled: true,
        scrollViewPanMinimumTouches: videoTouchEnabled ? 2 : 1,
        relativeControlsHidden: full,
        relativeControlsAlpha: 1.0,
        relativeControlsInteractionEnabled: !full,
        usesFullLayout: full
    )
}

func videoTouchTapInputs(for retarget: CursorViewportRetarget?) -> [NormalizedInput] {
    guard let retarget else { return [] }
    return [
        .cursorSet(
            displayId: retarget.displayId,
            x: Float(retarget.hostPoint.x),
            y: Float(retarget.hostPoint.y)
        ),
        .click(button: .left)
    ]
}
