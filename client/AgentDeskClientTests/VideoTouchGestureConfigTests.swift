import Testing
import CoreGraphics
import AgentDeskWire

// Finger-count routing for Touch mode is independent from the Full/As Is layout
// choice. The scroll view stays zoom-capable in all combinations
// (isScrollEnabled must never be false — that was the original pinch bug).
struct VideoTouchGestureConfigTests {
    @Test func asIsLayoutWithTouchModeOffKeepsControlsAndLocalVideoGestures() {
        let config = videoTouchGestureConfig(videoTouchEnabled: false, layoutMode: .asIs)
        #expect(config.videoTouchTapRecognizerEnabled)
        #expect(config.videoTouchScrollRecognizerEnabled == false)
        #expect(config.doubleTapZoomRecognizerEnabled)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func asIsLayoutWithTouchModeOnKeepsControlsAndRoutesVideoTouchToHost() {
        let config = videoTouchGestureConfig(videoTouchEnabled: true, layoutMode: .asIs)
        #expect(config.videoTouchTapRecognizerEnabled)
        #expect(config.videoTouchScrollRecognizerEnabled)
        #expect(config.doubleTapZoomRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func fullLayoutWithTouchModeOffHidesControlsAndKeepsLocalVideoGestures() {
        let config = videoTouchGestureConfig(videoTouchEnabled: false, layoutMode: .full)
        #expect(config.videoTouchTapRecognizerEnabled)
        #expect(config.videoTouchScrollRecognizerEnabled == false)
        #expect(config.doubleTapZoomRecognizerEnabled)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled == false)
        #expect(config.usesFullLayout)
    }

    @Test func fullLayoutWithTouchModeOnHidesControlsAndRoutesVideoTouchToHost() {
        let config = videoTouchGestureConfig(videoTouchEnabled: true, layoutMode: .full)
        #expect(config.videoTouchTapRecognizerEnabled)
        #expect(config.videoTouchScrollRecognizerEnabled)
        #expect(config.doubleTapZoomRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
        #expect(config.relativeControlsHidden)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled == false)
        #expect(config.usesFullLayout)
    }

    // Regression guard against reintroducing isScrollEnabled = false, which also
    // disables pinch-zoom on a UIScrollView.
    @Test func scrollViewStaysZoomCapableInEveryLayoutAndTouchModeState() {
        for layoutMode in VideoLayoutMode.allCases {
            #expect(videoTouchGestureConfig(videoTouchEnabled: false, layoutMode: layoutMode).scrollViewScrollEnabled == true)
            #expect(videoTouchGestureConfig(videoTouchEnabled: true, layoutMode: layoutMode).scrollViewScrollEnabled == true)
        }
    }

    @Test func layoutStateChangesDoNotChangeTouchModeEnabled() {
        let state = RemoteInputModeControlState(
            layoutMode: .asIs,
            videoTouchEnabled: true,
            autoKeyboardEnabled: false
        )
        let full = state.with(layoutMode: .full)
        #expect(full.layoutMode == .full)
        #expect(full.videoTouchEnabled == true)
        #expect(full.autoKeyboardEnabled == false)

        let asIs = full.with(layoutMode: .asIs)
        #expect(asIs.layoutMode == .asIs)
        #expect(asIs.videoTouchEnabled == true)
        #expect(asIs.autoKeyboardEnabled == false)
    }

    @Test func touchModeStateChangesDoNotChangeLayoutOrAutoKeyboard() {
        let state = RemoteInputModeControlState(
            layoutMode: .full,
            videoTouchEnabled: false,
            autoKeyboardEnabled: true
        )
        let enabled = state.with(videoTouchEnabled: true)
        #expect(enabled.layoutMode == .full)
        #expect(enabled.videoTouchEnabled == true)
        #expect(enabled.autoKeyboardEnabled)

        let disabled = enabled.with(videoTouchEnabled: false)
        #expect(disabled.layoutMode == .full)
        #expect(disabled.videoTouchEnabled == false)
        #expect(disabled.autoKeyboardEnabled)
    }

    @Test func autoKeyboardStateChangesDoNotChangeLayoutOrTouchMode() {
        let state = RemoteInputModeControlState(
            layoutMode: .full,
            videoTouchEnabled: true,
            autoKeyboardEnabled: true
        )
        let disabled = state.with(autoKeyboardEnabled: false)
        #expect(disabled.layoutMode == .full)
        #expect(disabled.videoTouchEnabled)
        #expect(disabled.autoKeyboardEnabled == false)

        let enabled = disabled.with(autoKeyboardEnabled: true)
        #expect(enabled.layoutMode == .full)
        #expect(enabled.videoTouchEnabled)
        #expect(enabled.autoKeyboardEnabled)
    }

    @Test func validVideoTapEmitsCursorSetThenLeftClick() {
        let inputs = videoTouchTapInputs(for: CursorViewportRetarget(
            displayId: "display-a",
            sourcePoint: CGPoint(x: 100, y: 200),
            hostPoint: CGPoint(x: 300, y: 400)
        ))
        #expect(inputs == [
            .cursorSet(displayId: "display-a", x: 300, y: 400),
            .click(button: .left)
        ])
    }

    @Test func invalidVideoTapEmitsNothing() {
        #expect(videoTouchTapInputs(for: nil).isEmpty)
    }
}
