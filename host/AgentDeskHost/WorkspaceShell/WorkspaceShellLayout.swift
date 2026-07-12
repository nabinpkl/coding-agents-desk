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

    init(sidebarWidth: CGFloat = 240, topBarHeight: CGFloat = 38, dockEnrichmentHeight: CGFloat = 82) {
        self.sidebarWidth = sidebarWidth
        self.topBarHeight = topBarHeight
        self.dockEnrichmentHeight = dockEnrichmentHeight
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
        pinned: Set<WorkspaceShellSurface> = []
    ) -> WorkspaceShellLayout {
        let sidebarWidth = max(0, min(configuration.sidebarWidth, screen.width))
        let topBarHeight = max(0, min(configuration.topBarHeight, screen.height))
        let dockHeight = max(0, min(configuration.dockEnrichmentHeight, screen.height))
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
        // Full-width strip along the bottom edge, revealed on a bottom hover. Like the Dock it floats
        // over the slot and reserves no content space (it is an ephemeral overview, not a pinned bar).
        let dockEnrichment = CGRect(
            x: screen.minX,
            y: screen.minY,
            width: screen.width,
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
