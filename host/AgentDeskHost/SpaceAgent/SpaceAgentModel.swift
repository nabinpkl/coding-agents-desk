import Foundation

struct SpaceAgentTile: Equatable {
    let spaceId: UInt64
    let title: String
    let secondary: String
    let desktopNumber: Int
    let isActive: Bool
    let stepDelta: Int
    let thumbnail: Data?
    // Full, untruncated text the palette filters against: the real window
    // title and app name. title/secondary above are truncated for display, so
    // searching must use this instead or long names stop matching past the
    // ellipsis. The desktop number is matched separately, not folded in here.
    let searchText: String
    // Keyboard-selection highlight in the search palette, set by the view
    // layer (not the model). Distinct from isActive, which is the desktop
    // you are currently on.
    var isSelected: Bool = false

    init(
        spaceId: UInt64,
        title: String,
        secondary: String = "",
        desktopNumber: Int = 0,
        isActive: Bool,
        stepDelta: Int,
        thumbnail: Data?,
        searchText: String = ""
    ) {
        self.spaceId = spaceId
        self.title = title
        self.secondary = secondary
        self.desktopNumber = desktopNumber
        self.isActive = isActive
        self.stepDelta = stepDelta
        self.thumbnail = thumbnail
        self.searchText = searchText
    }
}

enum SpaceAgentModel {
    static func tiles(
        state: DesktopState?,
        thumbnails: [UInt64: Data],
        topWindows: [UInt64: SpaceTopWindow] = [:]
    ) -> [SpaceAgentTile] {
        guard let state, let activeDisplayId = state.activeDisplayId else { return [] }
        let userSpaces = state.spaces
            .filter { $0.displayId == activeDisplayId && $0.type == 0 }
            .sorted { lhs, rhs in
                (lhs.index ?? Int.max) < (rhs.index ?? Int.max)
            }
        guard !userSpaces.isEmpty else { return [] }
        let activeOrdinal = userSpaces.firstIndex { $0.id == state.activeSpaceId }
        return userSpaces.enumerated().map { ordinal, space in
            let displayIndex = (space.index ?? ordinal) + 1
            let fallback = "Desktop \(displayIndex)"
            let topWindow = topWindows[space.id]
            let resolved = SpaceAgentLabelResolver.resolve(
                topWindow: topWindow,
                fallback: fallback
            )
            let isActive = space.id == state.activeSpaceId
            let delta: Int
            if let activeOrdinal, !isActive {
                delta = ordinal - activeOrdinal
            } else {
                delta = 0
            }
            // Search against the untruncated source: the real window title and
            // app name only. The desktop number is matched separately (by the
            // view layer), so the generic word "Desktop" does not get stapled
            // onto every tile and make a query like "desk" match all of them.
            var searchParts: [String] = []
            if let topWindow {
                searchParts.append(topWindow.title)
                if let appName = topWindow.appName { searchParts.append(appName) }
            }
            return SpaceAgentTile(
                spaceId: space.id,
                title: resolved.primary,
                secondary: resolved.secondary,
                desktopNumber: displayIndex,
                isActive: isActive,
                stepDelta: delta,
                thumbnail: thumbnails[space.id],
                searchText: searchParts.joined(separator: " ")
            )
        }
    }
}
