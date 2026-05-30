import Foundation

struct SpaceAgentTile: Equatable {
    let spaceId: UInt64
    let title: String
    let secondary: String
    let desktopNumber: Int
    let isActive: Bool
    let stepDelta: Int
    let thumbnail: Data?
    // Untruncated text the palette prefix-matches against, leading with the
    // real window title (the first-row name) so a query keys off the start of
    // that name. title above is truncated for display; the desktop number is
    // matched separately, not folded in here.
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

extension SpaceAgentTile {
    // Search bar (Discord-style): matches when any word in the name starts with
    // the query, so "desk" finds "agent-desk", "agent" finds the *-agent
    // desktops, and "code" finds Code desktops. Empty matches all; a numeric
    // query matches the desktop number.
    func matchesSearch(query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !trimmed.isEmpty else { return true }
        if let number = Int(trimmed), desktopNumber == number { return true }
        return searchTokens.contains { $0.hasPrefix(trimmed) }
    }

    // Hyper quick-switch: strict, the whole first-row name starts with the
    // query (searchText leads with the real window title), so a single letter
    // lands only on the desktops whose name begins with it.
    func matchesNamePrefix(query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !trimmed.isEmpty else { return true }
        if let number = Int(trimmed), desktopNumber == number { return true }
        return searchText.lowercased().hasPrefix(trimmed)
    }

    // Name split into lowercased word tokens on any non-alphanumeric boundary
    // (spaces, hyphens, dots, slashes), so each word is independently prefixable.
    private var searchTokens: [String] {
        searchText.lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
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
            // Search against the resolved rows (full, untruncated): the
            // first-row name leads so a prefix match keys off the name the user
            // actually sees, with the second row appended for word matches.
            // Empty parts are dropped so searchText leads with the real
            // identity, and the "Desktop N" fallback is never folded in (a
            // window-less Space has no name to match, only its number).
            var searchParts: [String] = []
            if topWindow != nil {
                if !resolved.primary.isEmpty { searchParts.append(resolved.primary) }
                if !resolved.secondary.isEmpty { searchParts.append(resolved.secondary) }
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
