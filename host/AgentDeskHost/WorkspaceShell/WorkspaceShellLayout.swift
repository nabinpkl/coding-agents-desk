import CoreGraphics

enum WorkspaceShellSurface: Hashable, CaseIterable {
    case sidebar
    case topBar
}

struct WorkspaceShellLayoutConfiguration: Equatable {
    let sidebarWidth: CGFloat
    let topBarHeight: CGFloat

    init(sidebarWidth: CGFloat = 240, topBarHeight: CGFloat = 38) {
        self.sidebarWidth = sidebarWidth
        self.topBarHeight = topBarHeight
    }
}

struct WorkspaceShellLayout: Equatable {
    let sidebar: CGRect
    let topBar: CGRect
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
        let reservedSidebarWidth = pinned.contains(.sidebar) ? sidebarWidth : 0
        let reservedTopBarHeight = pinned.contains(.topBar) ? topBarHeight : 0
        let content = CGRect(
            x: screen.minX + reservedSidebarWidth,
            y: screen.minY,
            width: max(0, screen.width - reservedSidebarWidth),
            height: max(0, screen.height - reservedTopBarHeight)
        )

        return WorkspaceShellLayout(sidebar: sidebar, topBar: topBar, content: content)
    }
}
