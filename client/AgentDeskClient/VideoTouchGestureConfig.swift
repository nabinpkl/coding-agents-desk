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
// A single tap is always routed so text fields can be focused and the iOS
// keyboard can be shown from host AX confirmation. Touch mode only controls
// one-finger drag/scroll routing; when it is off, local UIScrollView gestures
// keep their normal one-finger behavior.
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
        videoTouchTapRecognizerEnabled: true,
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
