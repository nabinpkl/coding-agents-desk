import CoreGraphics
import Foundation
import Testing

@MainActor
struct SpacesProviderTests {
    // Smoke test against the live SkyLight framework. Regression guard
    // for the private-API surface across macOS minor versions: if Apple
    // renames or removes any of the enumeration symbols (SLS / CGS
    // aliases), this fails. Does not assert specific id64 values; only
    // that we can enumerate at least one display with at least one
    // user (type=0) Space and the active Space resolves to one of them.
    @Test func currentReturnsAtLeastOneDisplayWithOneUserSpace() throws {
        let provider = SpacesProvider()
        guard let state = provider.current() else {
            Issue.record("SpacesProvider.current() returned nil; SkyLight binding likely broken")
            return
        }
        #expect(!state.displays.isEmpty)
        #expect(state.spaces.contains { $0.type == 0 })
        if let activeId = state.activeSpaceId {
            #expect(state.spaces.contains { $0.id == activeId })
        }
    }

    @Test func postDockSwipeFrameEmitsDockControlEventWithSwipeFields() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        _ = provider.postDockSwipeFrame(phase: .began, progress: 0.0, velocityX: 0.0)

        #expect(recorder.events.count == 1)
        guard let event = recorder.events.first else { return }
        // Field 55 = kCGSEventTypeField, value 30 = kCGSEventDockControl.
        #expect(event.getIntegerValueField(CGEventField(rawValue: 55)!) == 30)
        // Field 110 = kCGEventGestureHIDType, value 23 = kIOHIDEventTypeDockSwipe.
        #expect(event.getIntegerValueField(CGEventField(rawValue: 110)!) == 23)
        // Field 123 = kCGEventGestureSwipeMotion, value 1 = horizontal.
        #expect(event.getIntegerValueField(CGEventField(rawValue: 123)!) == 1)
    }

    @Test func phasesMapToCGSGesturePhaseValues() {
        // Began=1, Changed=2, Ended=4, Cancelled=8 - matches the values
        // trackpad-native gestures emit, which is what Dock listens for.
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        _ = provider.postDockSwipeFrame(phase: .began,     progress: 0,    velocityX: 0)
        _ = provider.postDockSwipeFrame(phase: .changed,   progress: 0.3,  velocityX: 100)
        _ = provider.postDockSwipeFrame(phase: .ended,     progress: 0.95, velocityX: 1800)
        _ = provider.postDockSwipeFrame(phase: .cancelled, progress: 0,    velocityX: 0)

        #expect(recorder.events.count == 4)
        let phaseField = CGEventField(rawValue: 132)!
        #expect(recorder.events[0].getIntegerValueField(phaseField) == 1)
        #expect(recorder.events[1].getIntegerValueField(phaseField) == 2)
        #expect(recorder.events[2].getIntegerValueField(phaseField) == 4)
        #expect(recorder.events[3].getIntegerValueField(phaseField) == 8)
    }

    @Test func progressAndVelocityPassThroughToEventFields() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        _ = provider.postDockSwipeFrame(phase: .changed, progress: 0.5, velocityX: 1234.5)

        #expect(recorder.events.count == 1)
        guard let event = recorder.events.first else { return }
        // Field 124 = kCGEventGestureSwipeProgress.
        #expect(event.getDoubleValueField(CGEventField(rawValue: 124)!) == 0.5)
        // Fields 129 + 130 = kCGEventGestureSwipeVelocityX/Y; we set both
        // to the same value (Dock uses the magnitude either way).
        #expect(event.getDoubleValueField(CGEventField(rawValue: 129)!) == 1234.5)
        #expect(event.getDoubleValueField(CGEventField(rawValue: 130)!) == 1234.5)
    }

    @Test func negativeProgressEncodesLeftDirection() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        _ = provider.postDockSwipeFrame(phase: .changed, progress: -0.4, velocityX: -800)

        #expect(recorder.events.count == 1)
        guard let event = recorder.events.first else { return }
        let progress = event.getDoubleValueField(CGEventField(rawValue: 124)!)
        let velocity = event.getDoubleValueField(CGEventField(rawValue: 129)!)
        #expect(progress < 0)
        #expect(velocity < 0)
    }

    // commitStep expands one .switchSpaceStep wire frame into |delta|
    // back-to-back Began/Changed/Ended dock-swipe cycles on a dedicated
    // queue. These tests verify the cycle count, phase ordering, and
    // sign-pass-through. The _drainSwitchQueueForTests barrier waits
    // for the async chain to finish before assertions run.

    @Test func commitStepZeroDeltaEmitsNothing() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        provider.commitStep(delta: 0)
        provider._drainSwitchQueueForTests()

        #expect(recorder.events.isEmpty)
    }

    @Test func commitStepUnitDeltaEmitsOneCycleInPhaseOrder() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        provider.commitStep(delta: 1)
        provider._drainSwitchQueueForTests()

        #expect(recorder.events.count == 3)
        let phaseField = CGEventField(rawValue: 132)!
        #expect(recorder.events[0].getIntegerValueField(phaseField) == 1) // Began
        #expect(recorder.events[1].getIntegerValueField(phaseField) == 2) // Changed
        #expect(recorder.events[2].getIntegerValueField(phaseField) == 4) // Ended
    }

    @Test func commitStepMultiDeltaEmitsThreeFramesPerStep() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        provider.commitStep(delta: 3)
        provider._drainSwitchQueueForTests()

        #expect(recorder.events.count == 9)
        let phaseField = CGEventField(rawValue: 132)!
        // Three repetitions of began -> changed -> ended.
        for cycle in 0..<3 {
            let base = cycle * 3
            #expect(recorder.events[base].getIntegerValueField(phaseField) == 1)
            #expect(recorder.events[base + 1].getIntegerValueField(phaseField) == 2)
            #expect(recorder.events[base + 2].getIntegerValueField(phaseField) == 4)
        }
    }

    @Test func commitStepPositiveDeltaEmitsPositiveProgress() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        provider.commitStep(delta: 1)
        provider._drainSwitchQueueForTests()

        let progressField = CGEventField(rawValue: 124)!
        // Began is exactly 0; Changed and Ended carry positive progress.
        #expect(recorder.events[0].getDoubleValueField(progressField) == 0)
        #expect(recorder.events[1].getDoubleValueField(progressField) > 0)
        #expect(recorder.events[2].getDoubleValueField(progressField) > 0)
    }

    @Test func commitStepNegativeDeltaEmitsNegativeProgress() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(eventPoster: { recorder.record($0) })

        provider.commitStep(delta: -1)
        provider._drainSwitchQueueForTests()

        let progressField = CGEventField(rawValue: 124)!
        #expect(recorder.events[0].getDoubleValueField(progressField) == 0)
        #expect(recorder.events[1].getDoubleValueField(progressField) < 0)
        #expect(recorder.events[2].getDoubleValueField(progressField) < 0)
    }
}

private final class EventRecorder {
    private(set) var events: [CGEvent] = []
    func record(_ event: CGEvent) {
        events.append(event)
    }
}
