import Foundation
import AgentDeskWire

enum VideoLayoutMode: String, CaseIterable, Equatable {
    case asIs
    case full
    // TeamViewer's mouse mode. A one-finger drag anywhere on the video moves the Mac's
    // pointer; the picture itself never pans under the finger. It moves only when the pointer
    // reaches the edge of what is visible, which is ADR-0009 edge follow, already built and
    // already driven by exactly the `cursorMove` frames this mode emits.
    //
    // It sits beside `full` and `asIs` rather than on its own axis, so choosing it is choosing
    // a layout too: full-bleed, because the video has become the input surface and the
    // trackpad under it has nothing left to do.
    case pointer

    // `asIs` keeps the Mac picture in a band with the trackpad and strips below it. Both other
    // modes give the picture the whole surface.
    var usesFullLayout: Bool { self != .asIs }
}

// What a one-finger drag on the video does. The three modes each claim it differently, and it
// is the only gesture all three want, so the binding is named rather than inferred from a
// pair of booleans at each call site.
enum VideoOneFingerPanBinding: Equatable {
    // Nobody remote: the local viewport pans, which is what a zoomed picture does by default.
    case none
    // Touch mode: scroll the Mac's app content, after priming the cursor at the touch point.
    case remoteScroll
    // Pointer mode: move the Mac's pointer by the finger's travel.
    case pointerMove
}

struct RemoteInputModeControlState: Equatable {
    var layoutMode: VideoLayoutMode
    var videoTouchEnabled: Bool
    var autoKeyboardEnabled: Bool

    func with(layoutMode newLayoutMode: VideoLayoutMode) -> RemoteInputModeControlState {
        RemoteInputModeControlState(
            layoutMode: newLayoutMode,
            videoTouchEnabled: videoTouchEnabled,
            autoKeyboardEnabled: autoKeyboardEnabled
        )
    }

    func with(videoTouchEnabled newVideoTouchEnabled: Bool) -> RemoteInputModeControlState {
        RemoteInputModeControlState(
            layoutMode: layoutMode,
            videoTouchEnabled: newVideoTouchEnabled,
            autoKeyboardEnabled: autoKeyboardEnabled
        )
    }

    func with(autoKeyboardEnabled newAutoKeyboardEnabled: Bool) -> RemoteInputModeControlState {
        RemoteInputModeControlState(
            layoutMode: layoutMode,
            videoTouchEnabled: videoTouchEnabled,
            autoKeyboardEnabled: newAutoKeyboardEnabled
        )
    }
}

// Finger-count gesture routing for video touch input, as a pure value so the
// UIKit apply step (applyVideoTouchState) stays a trivial translator and the
// routing is unit-testable without a view controller. Mirrors the
// ControlSurface.visibility(for:) pattern. Design:
// docs/superpowers/specs/2026-07-03-touch-scroll-pinch-zoom-design.md
//
// Touch mode gates all remote input from the video surface. When it is off,
// the video remains local-only: one-finger taps do nothing remote, one-finger
// drags stay with the local UIScrollView, and double-tap zoom remains
// available. When it is on, one-finger taps and drags route to the host.
struct VideoTouchGestureConfig: Equatable {
    let videoTouchTapRecognizerEnabled: Bool
    let oneFingerPanBinding: VideoOneFingerPanBinding
    // Two fingers scroll the Mac in pointer mode, because one finger is spoken for and the
    // right-edge strip cannot have that job here: edge follow needs the pointer pushed
    // against the right edge, which is exactly where the strip would be sitting.
    let twoFingerRemoteScrollEnabled: Bool
    let doubleTapZoomRecognizerEnabled: Bool
    let scrollViewScrollEnabled: Bool
    // The scroll view's own pan, which is what moves the picture locally. Off in pointer mode:
    // the picture is not the thing that moves. Note this is NOT `scrollViewScrollEnabled`,
    // which stays on because turning it off takes pinch zoom with it.
    let scrollViewPanEnabled: Bool
    let scrollViewPanMinimumTouches: Int
    // Whether a tap jumps the pointer to the finger. True in Touch mode, where the finger is
    // the pointer. False in pointer mode, where the pointer was steered somewhere and a tap
    // that moved it first would contradict every drag that came before.
    let tapRetargetsCursor: Bool
    let relativeControlsHidden: Bool
    let relativeControlsAlpha: Double
    let relativeControlsInteractionEnabled: Bool
    let usesFullLayout: Bool
}

func videoTouchGestureConfig(
    videoTouchEnabled: Bool,
    layoutMode: VideoLayoutMode,
    keyboardIsShown: Bool
) -> VideoTouchGestureConfig {
    let pointer = layoutMode == .pointer
    // Pointer mode is a video-input mode by definition, so it does not consult the Touch
    // switch: leaving that switch able to strip the mode of its own bindings would be a
    // setting whose only effect is to make the surface do nothing.
    let videoIsAnInputSurface = pointer || videoTouchEnabled
    let hidesRelativeControls = layoutMode.usesFullLayout || keyboardIsShown
    return VideoTouchGestureConfig(
        videoTouchTapRecognizerEnabled: videoIsAnInputSurface,
        oneFingerPanBinding: pointer
            ? .pointerMove
            : (videoTouchEnabled ? .remoteScroll : .none),
        twoFingerRemoteScrollEnabled: pointer,
        doubleTapZoomRecognizerEnabled: !videoIsAnInputSurface,
        scrollViewScrollEnabled: true,
        scrollViewPanEnabled: !pointer,
        scrollViewPanMinimumTouches: videoTouchEnabled ? 2 : 1,
        tapRetargetsCursor: !pointer,
        relativeControlsHidden: hidesRelativeControls,
        relativeControlsAlpha: 1.0,
        relativeControlsInteractionEnabled: !hidesRelativeControls,
        usesFullLayout: layoutMode.usesFullLayout
    )
}

func videoTouchTapInputs(
    for retarget: CursorViewportRetarget?,
    retargetsCursor: Bool = true
) -> [NormalizedInput] {
    // Pointer mode: click wherever the pointer was steered to. No retarget frame at all, so
    // there is nothing for the click to disagree with.
    guard retargetsCursor else { return [.click(button: .left)] }
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
