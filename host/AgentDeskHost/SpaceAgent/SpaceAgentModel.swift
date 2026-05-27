import Foundation

struct SpaceAgentTile: Equatable {
    let spaceId: UInt64
    let title: String
    let secondary: String
    let isActive: Bool
    let stepDelta: Int
    let thumbnail: Data?

    init(
        spaceId: UInt64,
        title: String,
        secondary: String = "",
        isActive: Bool,
        stepDelta: Int,
        thumbnail: Data?
    ) {
        self.spaceId = spaceId
        self.title = title
        self.secondary = secondary
        self.isActive = isActive
        self.stepDelta = stepDelta
        self.thumbnail = thumbnail
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
            let resolved = SpaceAgentLabelResolver.resolve(
                topWindow: topWindows[space.id],
                fallback: fallback
            )
            let isActive = space.id == state.activeSpaceId
            let delta: Int
            if let activeOrdinal, !isActive {
                delta = ordinal - activeOrdinal
            } else {
                delta = 0
            }
            return SpaceAgentTile(
                spaceId: space.id,
                title: resolved.primary,
                secondary: resolved.secondary,
                isActive: isActive,
                stepDelta: delta,
                thumbnail: thumbnails[space.id]
            )
        }
    }
}
