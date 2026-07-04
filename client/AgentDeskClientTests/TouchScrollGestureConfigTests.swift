import Testing

// Finger-count routing for touch-scroll mode. One finger scrolls the host at any
// zoom; two fingers drive native UIScrollView pinch + pan-while-pinched. The
// scroll view stays zoom-capable in both modes (isScrollEnabled must never be
// false — that was the original bug that killed pinch).
struct TouchScrollGestureConfigTests {
    @Test func offModeDisablesTouchScrollAndKeepsSingleFingerScrollView() {
        let config = touchScrollGestureConfig(touchScrollMode: .off)
        #expect(config.touchScrollRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func asIsModeRoutesOneFingerToTouchScrollAndKeepsControlsVisible() {
        let config = touchScrollGestureConfig(touchScrollMode: .asIs)
        #expect(config.touchScrollRecognizerEnabled == true)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
        #expect(config.relativeControlsHidden == false)
        #expect(config.relativeControlsAlpha == 1.0)
        #expect(config.relativeControlsInteractionEnabled)
        #expect(config.usesFullLayout == false)
    }

    @Test func fullModeRoutesOneFingerToTouchScrollAndHidesControls() {
        let config = touchScrollGestureConfig(touchScrollMode: .full)
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
    @Test func scrollViewStaysZoomCapableInAllModes() {
        #expect(touchScrollGestureConfig(touchScrollMode: .off).scrollViewScrollEnabled == true)
        #expect(touchScrollGestureConfig(touchScrollMode: .asIs).scrollViewScrollEnabled == true)
        #expect(touchScrollGestureConfig(touchScrollMode: .full).scrollViewScrollEnabled == true)
    }

    @Test func toggleSelectedFullModeBackOff() {
        let full = toggledTouchScrollMode(current: .off, selected: .full)
        #expect(full == .full)
        #expect(toggledTouchScrollMode(current: full, selected: .full) == .off)
    }

    @Test func toggleSelectedAsIsModeBackOff() {
        let asIs = toggledTouchScrollMode(current: .off, selected: .asIs)
        #expect(asIs == .asIs)
        #expect(toggledTouchScrollMode(current: asIs, selected: .asIs) == .off)
    }

    @Test func selectedModeSwitchesDirectlyToOtherMode() {
        #expect(toggledTouchScrollMode(current: .full, selected: .asIs) == .asIs)
        #expect(toggledTouchScrollMode(current: .asIs, selected: .full) == .full)
    }

    @Test func storedBoolMigratesToTriStateMode() {
        #expect(persistedTouchScrollMode(fromStoredValue: true) == .asIs)
        #expect(persistedTouchScrollMode(fromStoredValue: false) == .off)
        #expect(persistedTouchScrollMode(fromStoredValue: nil) == .off)
    }

    @Test func storedRawValueLoadsTriStateMode() {
        #expect(persistedTouchScrollMode(fromStoredValue: "off") == .off)
        #expect(persistedTouchScrollMode(fromStoredValue: "asIs") == .asIs)
        #expect(persistedTouchScrollMode(fromStoredValue: "full") == .full)
        #expect(persistedTouchScrollMode(fromStoredValue: "unknown") == .off)
    }
}
