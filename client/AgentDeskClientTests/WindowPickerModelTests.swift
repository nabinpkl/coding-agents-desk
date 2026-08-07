import Testing
import AgentDeskWire

// Desktop badge derivation for the window picker. The host deliberately does not send the
// Desktop number -- DesktopState already carries it, and a second copy on the wire is a
// second thing that can go stale -- so this join is the only place the badge is decided.
struct WindowPickerModelTests {
    private func state(spaces: [SpaceMetadata]) -> DesktopState {
        DesktopState(
            displays: [DisplayMetadata(id: "d1", widthPoints: 1800, heightPoints: 1169)],
            spaces: spaces,
            activeDisplayId: "d1",
            activeSpaceId: nil
        )
    }

    @Test func numbersUserSpacesInIndexOrder() {
        let ordinals = WindowPickerModel.desktopOrdinals(from: state(spaces: [
            SpaceMetadata(id: 300, displayId: "d1", index: 3, type: 0),
            SpaceMetadata(id: 100, displayId: "d1", index: 1, type: 0),
            SpaceMetadata(id: 200, displayId: "d1", index: 2, type: 0)
        ]))

        #expect(ordinals[100] == 1)
        #expect(ordinals[200] == 2)
        #expect(ordinals[300] == 3)
    }

    // Fullscreen Spaces (type != 0) are not Desktops and are not numbered as such by macOS.
    // Counting them would push every real Desktop's badge off by one.
    @Test func skipsNonUserSpaces() {
        let ordinals = WindowPickerModel.desktopOrdinals(from: state(spaces: [
            SpaceMetadata(id: 100, displayId: "d1", index: 1, type: 0),
            SpaceMetadata(id: 150, displayId: "d1", index: 2, type: 4),
            SpaceMetadata(id: 200, displayId: "d1", index: 3, type: 0)
        ]))

        #expect(ordinals[100] == 1)
        #expect(ordinals[150] == nil)
        #expect(ordinals[200] == 2)
    }

    @Test func numbersEachDisplayFromOne() {
        let ordinals = WindowPickerModel.desktopOrdinals(from: state(spaces: [
            SpaceMetadata(id: 100, displayId: "d1", index: 1, type: 0),
            SpaceMetadata(id: 200, displayId: "d1", index: 2, type: 0),
            SpaceMetadata(id: 900, displayId: "d2", index: 1, type: 0)
        ]))

        #expect(ordinals[100] == 1)
        #expect(ordinals[200] == 2)
        #expect(ordinals[900] == 1)
    }

    // SkyLight declines to place a few windows, and a Space can leave DesktopState between
    // pushes. No badge is honest; a wrong number is not.
    @Test func omitsBadgeWhenSpaceIsUnknown() {
        let ordinals = WindowPickerModel.desktopOrdinals(from: state(spaces: [
            SpaceMetadata(id: 100, displayId: "d1", index: 1, type: 0)
        ]))

        #expect(WindowPickerModel.badgeText(spaceId: 100, ordinals: ordinals) == "1")
        #expect(WindowPickerModel.badgeText(spaceId: nil, ordinals: ordinals) == nil)
        #expect(WindowPickerModel.badgeText(spaceId: 999, ordinals: ordinals) == nil)
    }
}
