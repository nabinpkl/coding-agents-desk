import Testing

// Finger-count routing for touch-scroll mode. One finger scrolls the host at any
// zoom; two fingers drive native UIScrollView pinch + pan-while-pinched. The
// scroll view stays zoom-capable in both modes (isScrollEnabled must never be
// false — that was the original bug that killed pinch).
struct TouchScrollGestureConfigTests {
    @Test func offModeDisablesTouchScrollAndKeepsSingleFingerScrollView() {
        let config = touchScrollGestureConfig(touchScrollMode: false)
        #expect(config.touchScrollRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
    }

    @Test func onModeRoutesOneFingerToTouchScrollAndTwoToScrollView() {
        let config = touchScrollGestureConfig(touchScrollMode: true)
        #expect(config.touchScrollRecognizerEnabled == true)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
    }

    // Regression guard against reintroducing isScrollEnabled = false, which also
    // disables pinch-zoom on a UIScrollView.
    @Test func scrollViewStaysZoomCapableInBothModes() {
        #expect(touchScrollGestureConfig(touchScrollMode: false).scrollViewScrollEnabled == true)
        #expect(touchScrollGestureConfig(touchScrollMode: true).scrollViewScrollEnabled == true)
    }
}
