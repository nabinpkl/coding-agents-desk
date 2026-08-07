import AgentDeskWire

// Presentation model for the window picker strip. UIKit-free so it compiles into the test
// target and the ordering/badge rules can be asserted without a view hierarchy.
//
// Deliberately does NOT re-sort the windows. The host emits them in Desktop-then-app order
// and is the single authority on that; a second sort here is a second thing to keep in
// agreement. The client only derives the Desktop number, which the host does not send
// precisely because DesktopState already carries it.
enum WindowPickerModel {
    // Space id -> 1-based Desktop number, matching the labels the Spaces strip shows.
    //
    // Numbered within each display, because that is how macOS numbers Desktops and how the
    // strip above already reads. A window on a display the strip is not currently rendering
    // still gets a number, which can collide visually with the rendered display's numbers;
    // that is the same ambiguity macOS itself has and is not worth a second badge to solve.
    static func desktopOrdinals(from state: DesktopState) -> [UInt64: Int] {
        var byDisplay: [String: [SpaceMetadata]] = [:]
        for space in state.spaces where space.type == 0 {
            byDisplay[space.displayId, default: []].append(space)
        }
        var ordinals: [UInt64: Int] = [:]
        for (_, spaces) in byDisplay {
            let ordered = spaces.sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
            for (offset, space) in ordered.enumerated() {
                ordinals[space.id] = offset + 1
            }
        }
        return ordinals
    }

    // nil when the window has no Space (SkyLight declines a few) or the Space is not in the
    // current DesktopState. An absent badge is honest; a wrong number is not.
    static func badgeText(spaceId: UInt64?, ordinals: [UInt64: Int]) -> String? {
        guard let spaceId, let ordinal = ordinals[spaceId] else { return nil }
        return String(ordinal)
    }
}
