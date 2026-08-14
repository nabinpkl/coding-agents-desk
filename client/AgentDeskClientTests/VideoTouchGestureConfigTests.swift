import Testing
import CoreGraphics
import AgentDeskWire

// Finger-count routing for Touch mode is independent from the Full/As Is layout
// choice. The scroll view stays zoom-capable in all combinations
// (isScrollEnabled must never be false — that was the original pinch bug).
struct VideoTouchGestureConfigTests {
    @Test func asIsLayoutWithTouchModeOffKeepsControlsAndLocalVideoGestures() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .asIs,
            keyboardIsShown: false
        )
        #expect(config.videoTouchTapRecognizerEnabled == false)
        #expect(config.oneFingerPanBinding == .none)
        #expect(config.doubleTapZoomRecognizerEnabled)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func asIsLayoutWithTouchModeOnKeepsControlsAndRoutesVideoTouchToHost() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: true,
            layoutMode: .asIs,
            keyboardIsShown: false
        )
        #expect(config.videoTouchTapRecognizerEnabled)
        #expect(config.oneFingerPanBinding == .remoteScroll)
        #expect(config.doubleTapZoomRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func fullLayoutWithTouchModeOffHidesControlsAndKeepsLocalVideoGestures() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .full,
            keyboardIsShown: false
        )
        #expect(config.videoTouchTapRecognizerEnabled == false)
        #expect(config.oneFingerPanBinding == .none)
        #expect(config.doubleTapZoomRecognizerEnabled)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled == false)
        #expect(config.usesFullLayout)
    }

    @Test func fullLayoutWithTouchModeOnHidesControlsAndRoutesVideoTouchToHost() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: true,
            layoutMode: .full,
            keyboardIsShown: false
        )
        #expect(config.videoTouchTapRecognizerEnabled)
        #expect(config.oneFingerPanBinding == .remoteScroll)
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
            #expect(videoTouchGestureConfig(
                videoTouchEnabled: false,
                layoutMode: layoutMode,
                keyboardIsShown: false
            ).scrollViewScrollEnabled == true)
            #expect(videoTouchGestureConfig(
                videoTouchEnabled: true,
                layoutMode: layoutMode,
                keyboardIsShown: false
            ).scrollViewScrollEnabled == true)
        }
    }

    @Test func shownKeyboardHidesAndDisablesRelativeControlsWithoutChangingVideoTouchRouting() {
        for videoTouchEnabled in [false, true] {
            let config = videoTouchGestureConfig(
                videoTouchEnabled: videoTouchEnabled,
                layoutMode: .asIs,
                keyboardIsShown: true
            )
            #expect(config.videoTouchTapRecognizerEnabled == videoTouchEnabled)
            #expect(config.oneFingerPanBinding == (videoTouchEnabled ? .remoteScroll : VideoOneFingerPanBinding.none))
            #expect(config.relativeControlsHidden)
            #expect(config.relativeControlsInteractionEnabled == false)
            #expect(config.usesFullLayout == false)
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

    // MARK: - Pointer mode
    //
    // TeamViewer's mouse mode. One finger moves the Mac's pointer and the picture holds
    // still; it moves only when the pointer reaches the edge, which is ADR-0009 edge follow
    // reacting to the same `cursorMove` frames the trackpad already sends.

    @Test func pointerModeBindsOneFingerToThePointer() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .pointer,
            keyboardIsShown: false
        )
        #expect(config.oneFingerPanBinding == .pointerMove)
        #expect(config.twoFingerRemoteScrollEnabled)
    }

    // The two taps are separate recognizers on separate views, and exactly one is ever live.
    // Touch mode's is bound to the picture because it means "the host point under this
    // finger". Pointer mode's is bound to the whole video surface, because it means "click
    // where the pointer is" and so has an answer on the black letterbox bands too -- which on
    // a landscape Mac shown on a portrait phone are most of the surface.
    @Test func exactlyOneTapSurfaceIsLivePerMode() {
        let pointer = videoTouchGestureConfig(
            videoTouchEnabled: true,
            layoutMode: .pointer,
            keyboardIsShown: false
        )
        #expect(pointer.pointerTapRecognizerEnabled)
        #expect(pointer.videoTouchTapRecognizerEnabled == false)

        let touch = videoTouchGestureConfig(
            videoTouchEnabled: true,
            layoutMode: .full,
            keyboardIsShown: false
        )
        #expect(touch.videoTouchTapRecognizerEnabled)
        #expect(touch.pointerTapRecognizerEnabled == false)

        let off = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .asIs,
            keyboardIsShown: false
        )
        #expect(off.videoTouchTapRecognizerEnabled == false)
        #expect(off.pointerTapRecognizerEnabled == false)
    }

    // The mode is a video-input mode by definition. If the Touch switch could still strip its
    // bindings, that switch would be a setting whose only effect is to make the video inert.
    @Test func pointerModeIgnoresTheTouchSwitch() {
        for videoTouchEnabled in [false, true] {
            let config = videoTouchGestureConfig(
                videoTouchEnabled: videoTouchEnabled,
                layoutMode: .pointer,
                keyboardIsShown: false
            )
            #expect(config.oneFingerPanBinding == .pointerMove)
            #expect(config.pointerTapRecognizerEnabled)
            #expect(config.tapRetargetsCursor == false)
        }
    }

    // The whole premise: the picture does not move under the finger, at any finger count.
    // Disabling the scroll view's PAN rather than its scrolling is what leaves pinch alive,
    // and edge follow reaches the offset through setContentOffset regardless.
    @Test func pointerModeStopsTheLocalViewportPanButKeepsZoom() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .pointer,
            keyboardIsShown: false
        )
        #expect(config.scrollViewPanEnabled == false)
        #expect(config.scrollViewScrollEnabled)
        #expect(config.doubleTapZoomRecognizerEnabled == false)
    }

    @Test func everyOtherModeKeepsTheLocalViewportPan() {
        for layoutMode in [VideoLayoutMode.asIs, .full] {
            for videoTouchEnabled in [false, true] {
                #expect(videoTouchGestureConfig(
                    videoTouchEnabled: videoTouchEnabled,
                    layoutMode: layoutMode,
                    keyboardIsShown: false
                ).scrollViewPanEnabled)
            }
        }
    }

    // Choosing Pointer is choosing a layout too: the video is the input surface now, so the
    // trackpad below it has nothing left to do and the picture takes the space.
    @Test func pointerModeIsFullBleedAndHidesTheRelativeControls() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .pointer,
            keyboardIsShown: false
        )
        #expect(config.usesFullLayout)
        #expect(config.relativeControlsHidden)
        #expect(VideoLayoutMode.pointer.usesFullLayout)
        #expect(VideoLayoutMode.full.usesFullLayout)
        #expect(VideoLayoutMode.asIs.usesFullLayout == false)
    }

    // The single most breakable line in the mode. A tap that resolved the touch point first
    // would jump the pointer to the finger, undoing whatever the last drag steered it to --
    // and the pointer is drawn on screen, so the user would watch it happen.
    @Test func aPointerModeTapClicksWhereThePointerIsAndSendsNoRetarget() {
        let inputs = videoTouchTapInputs(
            for: CursorViewportRetarget(
                displayId: "display-a",
                sourcePoint: CGPoint(x: 100, y: 200),
                hostPoint: CGPoint(x: 300, y: 400)
            ),
            retargetsCursor: false
        )
        #expect(inputs == [.click(button: .left)])
    }

    // And it still clicks with no retarget available at all, which is the state the caller is
    // actually in: pointer mode never resolves one.
    @Test func aPointerModeTapClicksEvenWithNoRetargetResolved() {
        #expect(videoTouchTapInputs(for: nil, retargetsCursor: false) == [.click(button: .left)])
    }

    // MARK: - The scroll clutch
    //
    // A floating puck in pointer mode that swaps what one finger means. Scrolling is the thing
    // you do most and two fingers is the gesture you cannot do one-handed, so the puck hands
    // one-finger drags to the scroll wheel and leaves the pointer parked.

    @Test func engagingTheClutchGivesOneFingerToScrolling() {
        let config = videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .pointer,
            keyboardIsShown: false,
            pointerScrollEngaged: true
        )
        #expect(config.oneFingerPanBinding == .pointerScroll)
    }

    // `pointerScroll` and `remoteScroll` are separate cases for one reason: Touch mode's scroll
    // primes the cursor at the touch point first, and doing that here would scroll whatever the
    // finger landed on rather than what the pointer was parked over -- and lose the parked
    // position on the way.
    @Test func theClutchScrollsWhereThePointerIsNotWhereTheFingerIs() {
        let clutched = videoTouchGestureConfig(
            videoTouchEnabled: true,
            layoutMode: .pointer,
            keyboardIsShown: false,
            pointerScrollEngaged: true
        )
        let touchMode = videoTouchGestureConfig(
            videoTouchEnabled: true,
            layoutMode: .full,
            keyboardIsShown: false
        )
        #expect(clutched.oneFingerPanBinding == .pointerScroll)
        #expect(touchMode.oneFingerPanBinding == .remoteScroll)
        #expect(clutched.oneFingerPanBinding != touchMode.oneFingerPanBinding)
    }

    // Two fingers keep working with the clutch engaged. Taking the gesture away would make
    // engaging the puck a trap on the one occasion the user forgot it was on.
    @Test func theClutchDoesNotTakeAwayTwoFingerScrolling() {
        #expect(videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .pointer,
            keyboardIsShown: false,
            pointerScrollEngaged: true
        ).twoFingerRemoteScrollEnabled)
    }

    // It exists only where it has something to swap. In the other two modes one finger is
    // already either the local viewport or the Mac's scroll wheel.
    @Test func theClutchIsPointerModeOnly() {
        #expect(videoTouchGestureConfig(
            videoTouchEnabled: false, layoutMode: .pointer, keyboardIsShown: false
        ).pointerScrollPuckVisible)
        for layoutMode in [VideoLayoutMode.asIs, .full] {
            #expect(videoTouchGestureConfig(
                videoTouchEnabled: true, layoutMode: layoutMode, keyboardIsShown: false
            ).pointerScrollPuckVisible == false)
        }
    }

    // Disengaged is the default, and the mode's own binding is untouched by a puck nobody has
    // tapped -- so adding the clutch changed nothing for anyone who never uses it.
    @Test func aDisengagedClutchLeavesPointerModeExactlyAsItWas() {
        #expect(videoTouchGestureConfig(
            videoTouchEnabled: false,
            layoutMode: .pointer,
            keyboardIsShown: false,
            pointerScrollEngaged: false
        ).oneFingerPanBinding == .pointerMove)
    }
}
