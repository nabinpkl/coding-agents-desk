import Foundation
import Testing

@MainActor
struct SpacesProviderTests {
    // Smoke test against the live SkyLight framework. Regression guard
    // for the private-API surface across macOS minor versions: if Apple
    // renames or removes any of CGSMainConnectionID,
    // CGSGetActiveSpace, CGSCopyManagedDisplaySpaces, this fails. Does
    // not assert specific id64 values; only that we can enumerate at
    // least one display with at least one user (type=0) Space and the
    // active Space resolves to one of them.
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

    @Test func planSwitchRightAdvancesToNextUserSpaceOnActiveDisplay() {
        let state = DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 300, displayId: "DISP-1", index: 2, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        )
        let plan = SpacesProvider.planSwitch(from: state, direction: .right)
        #expect(plan == SpaceSwitchPlan(displayId: "DISP-1", targetSpaceId: 200))
    }

    @Test func planSwitchLeftReturnsPreviousUserSpace() {
        let state = DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 200
        )
        let plan = SpacesProvider.planSwitch(from: state, direction: .left)
        #expect(plan == SpaceSwitchPlan(displayId: "DISP-1", targetSpaceId: 100))
    }

    @Test func planSwitchAtLeftEdgeReturnsNil() {
        // No wrap. Matches macOS: you can't loop Desktop 1 -> Desktop N.
        let state = DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        )
        #expect(SpacesProvider.planSwitch(from: state, direction: .left) == nil)
    }

    @Test func planSwitchAtRightEdgeReturnsNil() {
        let state = DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 200
        )
        #expect(SpacesProvider.planSwitch(from: state, direction: .right) == nil)
    }

    @Test func planSwitchSkipsFullscreenSpacesInWalk() {
        // Mission Control's left/right navigation walks user Spaces
        // only; fullscreen-app Spaces (type=4) are not in the carousel.
        // Provider must mirror that or the dot count and the OS view
        // would diverge.
        let state = DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 150, displayId: "DISP-1", index: nil, type: 4),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        )
        let plan = SpacesProvider.planSwitch(from: state, direction: .right)
        #expect(plan == SpaceSwitchPlan(displayId: "DISP-1", targetSpaceId: 200))
    }

    @Test func planSwitchOnSingleUserSpaceReturnsNil() {
        // Nothing to switch to; do not synthesise events the OS would
        // refuse, and do not silently fall through to a non-existent
        // neighbour.
        let state = DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        )
        #expect(SpacesProvider.planSwitch(from: state, direction: .right) == nil)
        #expect(SpacesProvider.planSwitch(from: state, direction: .left) == nil)
    }

    @Test func planSwitchIgnoresSpacesOnOtherDisplays() {
        let state = DesktopState(
            displays: [
                DisplayMetadata(id: "DISP-1"),
                DisplayMetadata(id: "DISP-2"),
            ],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 500, displayId: "DISP-2", index: 0, type: 0),
                SpaceMetadata(id: 600, displayId: "DISP-2", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        )
        // From DISP-1's Desktop 1, right should land on DISP-1's
        // Desktop 2, not on DISP-2's anything.
        let plan = SpacesProvider.planSwitch(from: state, direction: .right)
        #expect(plan == SpaceSwitchPlan(displayId: "DISP-1", targetSpaceId: 200))
    }
}
