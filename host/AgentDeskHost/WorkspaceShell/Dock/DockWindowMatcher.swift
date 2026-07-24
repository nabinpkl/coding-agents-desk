import CoreGraphics

enum DockAXWindowMatch: Equatable {
    case matched(Int)
    case missing
    case ambiguous
}

enum DockWindowMatcher {
    static func bestCGWindow(
        for ax: DockAXWindowFacts,
        in windows: [DockCGWindowFacts],
        excluding used: Set<UInt32>
    ) -> DockCGWindowFacts? {
        let available = windows.filter {
            isOrdinary($0) && !used.contains($0.windowID)
        }
        if let exactTitle = available.first(where: { !$0.title.isEmpty && $0.title == ax.title }) {
            return exactTitle
        }
        if let axBounds = ax.bounds,
           let boundsMatch = available.first(where: { close($0.bounds, to: axBounds) }) {
            return boundsMatch
        }
        return available.first { $0.layer == 0 }
    }

    static func isOrdinary(_ window: DockCGWindowFacts) -> Bool {
        window.layer == 0
    }

    /// Resolves one live AX window to an exact CG target. Focus must never use the snapshot reader's
    /// layer-zero fallback because choosing the wrong window is worse than rejecting an ambiguous tap.
    static func axWindow(
        matching target: DockCGWindowFacts,
        in windows: [DockAXWindowFacts]
    ) -> DockAXWindowMatch {
        let titleAndBounds = matchingIndexes(in: windows) { ax in
            !target.title.isEmpty &&
                ax.title == target.title &&
                ax.bounds.map { close($0, to: target.bounds) } == true
        }
        if let result = resolved(titleAndBounds) { return result }

        let bounds = matchingIndexes(in: windows) { ax in
            ax.bounds.map { close($0, to: target.bounds) } == true
        }
        if let result = resolved(bounds) { return result }

        guard !target.title.isEmpty else { return .missing }
        let title = matchingIndexes(in: windows) { $0.title == target.title }
        return resolved(title) ?? .missing
    }

    static func close(_ lhs: CGRect, to rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 2 &&
            abs(lhs.minY - rhs.minY) < 2 &&
            abs(lhs.width - rhs.width) < 2 &&
            abs(lhs.height - rhs.height) < 2
    }

    private static func matchingIndexes(
        in windows: [DockAXWindowFacts],
        where predicate: (DockAXWindowFacts) -> Bool
    ) -> [Int] {
        windows.indices.filter { predicate(windows[$0]) }
    }

    private static func resolved(_ indexes: [Int]) -> DockAXWindowMatch? {
        switch indexes.count {
        case 0:
            return nil
        case 1:
            return .matched(indexes[0])
        default:
            return .ambiguous
        }
    }
}
