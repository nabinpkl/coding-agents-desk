import CoreGraphics

enum WorkspaceShellSurface: Hashable, CaseIterable {
    case sidebar
    case topBar
    case dockEnrichment
}

struct WorkspaceShellLayoutConfiguration: Equatable {
    let sidebarWidth: CGFloat
    let topBarHeight: CGFloat
    let dockEnrichmentHeight: CGFloat
    let dockEnrichmentHorizontalInset: CGFloat
    let dockEnrichmentBottomOffset: CGFloat

    init(
        sidebarWidth: CGFloat = 240,
        topBarHeight: CGFloat = 38,
        dockEnrichmentHeight: CGFloat = 96,
        dockEnrichmentHorizontalInset: CGFloat = 12,
        dockEnrichmentBottomOffset: CGFloat = 16
    ) {
        self.sidebarWidth = sidebarWidth
        self.topBarHeight = topBarHeight
        self.dockEnrichmentHeight = dockEnrichmentHeight
        self.dockEnrichmentHorizontalInset = dockEnrichmentHorizontalInset
        self.dockEnrichmentBottomOffset = dockEnrichmentBottomOffset
    }
}

struct WorkspaceShellLayout: Equatable {
    let sidebar: CGRect
    let topBar: CGRect
    let dockEnrichment: CGRect
    let content: CGRect
}

enum WorkspaceShellLayoutCalculator {
    static func layout(
        in screen: CGRect,
        configuration: WorkspaceShellLayoutConfiguration = WorkspaceShellLayoutConfiguration(),
        pinned: Set<WorkspaceShellSurface> = [],
        dockBottomRevealInset: CGFloat = 0
    ) -> WorkspaceShellLayout {
        let sidebarWidth = max(0, min(configuration.sidebarWidth, screen.width))
        let topBarHeight = max(0, min(configuration.topBarHeight, screen.height))
        let sidebar = CGRect(
            x: screen.minX,
            y: screen.minY,
            width: sidebarWidth,
            height: screen.height
        )
        let topBar = CGRect(
            x: screen.minX,
            y: screen.maxY - topBarHeight,
            width: screen.width,
            height: topBarHeight
        )
        // A floating strip near the bottom edge, revealed on a bottom hover. It is inset horizontally
        // and lifted off the bottom by `dockEnrichmentBottomOffset` so it sits ABOVE the macOS Dock;
        // when the Dock auto-hides, `dockBottomRevealInset` (its revealed thickness) lifts it further so
        // a revealed Dock does not cover it. Reserves no content space (ephemeral overview).
        let dockHInset = max(0, min(configuration.dockEnrichmentHorizontalInset, screen.width / 2))
        let dockBottomOffset = max(0, configuration.dockEnrichmentBottomOffset + dockBottomRevealInset)
        let dockHeight = max(0, min(configuration.dockEnrichmentHeight, screen.height - dockBottomOffset))
        let dockEnrichment = CGRect(
            x: screen.minX + dockHInset,
            y: screen.minY + dockBottomOffset,
            width: max(0, screen.width - dockHInset * 2),
            height: dockHeight
        )
        let reservedSidebarWidth = pinned.contains(.sidebar) ? sidebarWidth : 0
        let reservedTopBarHeight = pinned.contains(.topBar) ? topBarHeight : 0
        let content = CGRect(
            x: screen.minX + reservedSidebarWidth,
            y: screen.minY,
            width: max(0, screen.width - reservedSidebarWidth),
            height: max(0, screen.height - reservedTopBarHeight)
        )

        return WorkspaceShellLayout(sidebar: sidebar, topBar: topBar, dockEnrichment: dockEnrichment, content: content)
    }
}
