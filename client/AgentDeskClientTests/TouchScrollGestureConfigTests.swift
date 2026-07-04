import Testing

// Finger-count routing for touch scroll is independent from the Full/As Is
// layout choice. The scroll view stays zoom-capable in all combinations
// (isScrollEnabled must never be false — that was the original pinch bug).
struct TouchScrollGestureConfigTests {
    @Test func asIsLayoutWithTouchScrollOffKeepsControlsAndSingleFingerScrollViewPan() {
        let config = touchScrollGestureConfig(touchScrollEnabled: false, layoutMode: .asIs)
        #expect(config.touchScrollRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func asIsLayoutWithTouchScrollOnKeepsControlsAndRoutesOneFingerToTouchScroll() {
        let config = touchScrollGestureConfig(touchScrollEnabled: true, layoutMode: .asIs)
        #expect(config.touchScrollRecognizerEnabled == true)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func fullLayoutWithTouchScrollOffHidesControlsAndKeepsSingleFingerScrollViewPan() {
        let config = touchScrollGestureConfig(touchScrollEnabled: false, layoutMode: .full)
        #expect(config.touchScrollRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled == false)
        #expect(config.usesFullLayout)
    }

    @Test func fullLayoutWithTouchScrollOnHidesControlsAndRoutesOneFingerToTouchScroll() {
        let config = touchScrollGestureConfig(touchScrollEnabled: true, layoutMode: .full)
        #expect(config.touchScrollRecognizerEnabled == true)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
        #expect(config.relativeControlsHidden)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled == false)
        #expect(config.usesFullLayout)
    }

    // Regression guard against reintroducing isScrollEnabled = false, which also
    // disables pinch-zoom on a UIScrollView.
    @Test func scrollViewStaysZoomCapableInEveryLayoutAndTouchScrollState() {
        for layoutMode in TouchScrollLayoutMode.allCases {
            #expect(touchScrollGestureConfig(touchScrollEnabled: false, layoutMode: layoutMode).scrollViewScrollEnabled == true)
            #expect(touchScrollGestureConfig(touchScrollEnabled: true, layoutMode: layoutMode).scrollViewScrollEnabled == true)
        }
    }

    @Test func layoutStateChangesDoNotChangeTouchScrollEnabled() {
        let state = TouchScrollControlState(layoutMode: .asIs, touchScrollEnabled: true)
        let full = state.with(layoutMode: .full)
        #expect(full.layoutMode == .full)
        #expect(full.touchScrollEnabled == true)

        let asIs = full.with(layoutMode: .asIs)
        #expect(asIs.layoutMode == .asIs)
        #expect(asIs.touchScrollEnabled == true)
    }

    @Test func touchScrollStateChangesDoNotChangeLayout() {
        let state = TouchScrollControlState(layoutMode: .full, touchScrollEnabled: false)
        let enabled = state.with(touchScrollEnabled: true)
        #expect(enabled.layoutMode == .full)
        #expect(enabled.touchScrollEnabled == true)

        let disabled = enabled.with(touchScrollEnabled: false)
        #expect(disabled.layoutMode == .full)
        #expect(disabled.touchScrollEnabled == false)
    }
}
