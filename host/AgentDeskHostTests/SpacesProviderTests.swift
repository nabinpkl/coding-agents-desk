import CoreGraphics
import Foundation
import Testing
import AgentDeskWire

@MainActor
struct SpacesProviderTests {
    @Test func displaySelectionRejectsUnavailableDisplayAndKeepsBoundsFallback() {
        let store = DisplaySelectionStore()

        #expect(store.select("display-b", availableDisplayIds: ["display-a"]) == false)
        #expect(store.selectedDisplayId == nil)
        #expect(store.select("display-a", availableDisplayIds: ["display-a"]) == true)
        #expect(store.selectedDisplayId == "display-a")
        #expect(store.select("display-a", availableDisplayIds: ["display-a"]) == false)
    }

    @Test func displaySelectionReconcileSeedsEmptySelectionWithFirstAttachedCandidate() {
        let store = DisplaySelectionStore()

        // The most-wanted candidate is not attached, so the next one wins.
        #expect(store.reconcile(availableDisplayIds: ["display-a"], preferring: [nil, "display-b", "display-a"]) == true)
        #expect(store.selectedDisplayId == "display-a")
    }

    @Test func displaySelectionReconcileLeavesAnAttachedSelectionAlone() {
        let store = DisplaySelectionStore()
        store.select("display-a", availableDisplayIds: ["display-a", "display-b"])

        // "display-b" is preferred, but the current selection is still attached, so a
        // reconcile is not a re-pick: only a missing display moves it.
        #expect(store.reconcile(availableDisplayIds: ["display-a", "display-b"], preferring: ["display-b"]) == false)
        #expect(store.selectedDisplayId == "display-a")
    }

    @Test func displaySelectionReconcileReHomesWhenTheSelectedDisplayIsUnplugged() {
        let store = DisplaySelectionStore()
        store.select("display-a", availableDisplayIds: ["display-a", "display-b"])

        // "display-a" is gone. `select` refuses to overwrite with an id it cannot verify
        // and there is no clear-on-absence anywhere else, so without `reconcile` the
        // selection would point at "display-a" forever and capture would have to guess.
        #expect(store.reconcile(availableDisplayIds: ["display-b"], preferring: ["display-a", "display-b"]) == true)
        #expect(store.selectedDisplayId == "display-b")
    }

    @Test func displaySelectionReconcileKeepsAStaleSelectionWhenNoCandidateIsAttached() {
        let store = DisplaySelectionStore()
        store.select("display-a", availableDisplayIds: ["display-a"])

        // Nothing to move to. Holding the stale id is what makes capture report
        // `.unavailable` instead of substituting a display nobody asked for.
        #expect(store.reconcile(availableDisplayIds: [], preferring: ["display-a", "display-b"]) == false)
        #expect(store.selectedDisplayId == "display-a")
    }

    @Test func spaceSwitchModeDefaultsToDockSwipeAndAcceptsDirectSetAliases() {
        #expect(Config.SpaceSwitchMode(rawEnvironmentValue: nil) == .dockSwipe)
        #expect(Config.SpaceSwitchMode(rawEnvironmentValue: "dock-swipe") == .dockSwipe)
        #expect(Config.SpaceSwitchMode(rawEnvironmentValue: "direct-set") == .directSet)
        #expect(Config.SpaceSwitchMode(rawEnvironmentValue: "direct_set") == .directSet)
        #expect(Config.SpaceSwitchMode(rawEnvironmentValue: "directset") == .directSet)
    }

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

    @Test func desktopAuditKeepsDisplayOrdinalsAndAddsMissionControlOrdinals() {
        let displays: [[String: Any]] = [
            [
                "Display Identifier": "primary",
                "Spaces": [
                    ["id64": NSNumber(value: 10), "type": NSNumber(value: 0)],
                    ["id64": NSNumber(value: 99), "type": NSNumber(value: 4)],
                    ["id64": NSNumber(value: 11), "type": NSNumber(value: 0)],
                ],
            ],
            [
                "Display Identifier": "secondary",
                "Spaces": [
                    ["id64": NSNumber(value: 20), "type": NSNumber(value: 0)],
                ],
            ],
        ]

        let desktops = skyLightAuditDesktops(from: displays, active: 20)

        #expect(desktops.map(\.id) == [10, 11, 20])
        #expect(desktops.map(\.ordinal) == [0, 1, 0])
        #expect(desktops.map(\.missionControlOrdinal) == [0, 1, 2])
        #expect(desktops.map(\.isActive) == [false, false, true])
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

    @Test func openMissionControlUsesApplicationOpener() {
        let recorder = EventRecorder()
        var openCalls = 0
        let provider = SpacesProvider(
            eventPoster: { recorder.record($0) },
            missionControlOpener: {
                openCalls += 1
                return true
            }
        )

        provider.openMissionControl()

        #expect(openCalls == 1)
        #expect(recorder.events.isEmpty)
    }

    @Test func openMissionControlDoesNotFallBackToDockSwipeWhenApplicationOpenFails() {
        let recorder = EventRecorder()
        let provider = SpacesProvider(
            eventPoster: { recorder.record($0) },
            missionControlOpener: { false }
        )

        provider.openMissionControl()

        #expect(recorder.events.isEmpty)
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

    @Test func directSetModeTargetsFinalUserSpaceWithoutDockSwipeEvents() {
        let recorder = EventRecorder()
        var activeSpaceId: UInt64 = 22
        var directSetCalls: [(displayId: String, spaceId: UInt64)] = []
        let provider = SpacesProvider(
            eventPoster: { recorder.record($0) },
            spaceSwitchMode: .directSet,
            currentStateProvider: {
                Self.desktopState(activeSpaceId: activeSpaceId)
            },
            directSpaceSetter: { displayId, spaceId in
                directSetCalls.append((displayId, spaceId))
                activeSpaceId = spaceId
                return true
            }
        )

        provider.commitStep(delta: 2)
        provider._drainSwitchQueueForTests()

        #expect(directSetCalls.count == 1)
        #expect(directSetCalls.first?.displayId == "main-display")
        #expect(directSetCalls.first?.spaceId == 44)
        #expect(recorder.events.isEmpty)
    }

    @Test func directSetModeFallsBackToDockSwipeWhenSetterFails() {
        let recorder = EventRecorder()
        var directSetCalls: [(displayId: String, spaceId: UInt64)] = []
        let provider = SpacesProvider(
            eventPoster: { recorder.record($0) },
            spaceSwitchMode: .directSet,
            currentStateProvider: {
                Self.desktopState(activeSpaceId: 22)
            },
            directSpaceSetter: { displayId, spaceId in
                directSetCalls.append((displayId, spaceId))
                return false
            }
        )

        provider.commitStep(delta: 1)
        provider._drainSwitchQueueForTests()

        #expect(directSetCalls.count == 1)
        #expect(directSetCalls.first?.spaceId == 33)
        #expect(recorder.events.count == 3)
    }

    @Test func directSetModeFallsBackWhenActiveSpaceIsNotAUserDesktop() {
        let recorder = EventRecorder()
        var directSetCalls: [(displayId: String, spaceId: UInt64)] = []
        let provider = SpacesProvider(
            eventPoster: { recorder.record($0) },
            spaceSwitchMode: .directSet,
            currentStateProvider: {
                Self.desktopState(activeSpaceId: 99)
            },
            directSpaceSetter: { displayId, spaceId in
                directSetCalls.append((displayId, spaceId))
                return true
            }
        )

        provider.commitStep(delta: 1)
        provider._drainSwitchQueueForTests()

        #expect(directSetCalls.isEmpty)
        #expect(recorder.events.count == 3)
    }

    @Test func directSetModeNoOpsWhenTargetOrdinalIsOutsideUserSpaces() {
        let recorder = EventRecorder()
        var directSetCalls: [(displayId: String, spaceId: UInt64)] = []
        let provider = SpacesProvider(
            eventPoster: { recorder.record($0) },
            spaceSwitchMode: .directSet,
            currentStateProvider: {
                Self.desktopState(activeSpaceId: 44)
            },
            directSpaceSetter: { displayId, spaceId in
                directSetCalls.append((displayId, spaceId))
                return true
            }
        )

        provider.commitStep(delta: 1)
        provider._drainSwitchQueueForTests()

        #expect(directSetCalls.isEmpty)
        #expect(recorder.events.isEmpty)
    }

    private static func desktopState(activeSpaceId: UInt64) -> DesktopState {
        DesktopState(
            displays: [
                DisplayMetadata(id: "main-display", widthPoints: 1512, heightPoints: 982)
            ],
            spaces: [
                SpaceMetadata(id: 11, displayId: "main-display", index: 0, type: 0),
                SpaceMetadata(id: 22, displayId: "main-display", index: 1, type: 0),
                SpaceMetadata(id: 33, displayId: "main-display", index: 2, type: 0),
                SpaceMetadata(id: 99, displayId: "main-display", index: nil, type: 4),
                SpaceMetadata(id: 44, displayId: "main-display", index: 3, type: 0)
            ],
            activeDisplayId: "main-display",
            activeSpaceId: activeSpaceId
        )
    }
}

private final class EventRecorder {
    private(set) var events: [CGEvent] = []
    func record(_ event: CGEvent) {
        events.append(event)
    }
}
