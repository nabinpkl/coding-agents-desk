import CoreGraphics
import Testing

@testable import AgentDeskHost

struct WorkspaceShellLayoutTests {
    @Test func unpinnedShellLeavesTheEntireScreenAvailable() {
        let screen = CGRect(x: 100, y: 50, width: 1440, height: 900)

        let layout = WorkspaceShellLayoutCalculator.layout(
            in: screen,
            configuration: WorkspaceShellLayoutConfiguration(sidebarWidth: 240, topBarHeight: 38)
        )

        #expect(layout.sidebar == CGRect(x: 100, y: 50, width: 240, height: 900))
        #expect(layout.topBar == CGRect(x: 100, y: 912, width: 1440, height: 38))
        #expect(layout.content == screen)
    }

    @Test func pinnedSurfacesReserveOnlyTheirOwnAxes() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)

        let layout = WorkspaceShellLayoutCalculator.layout(
            in: screen,
            configuration: WorkspaceShellLayoutConfiguration(sidebarWidth: 240, topBarHeight: 38),
            pinned: [.sidebar, .topBar]
        )

        #expect(layout.content == CGRect(x: 240, y: 0, width: 1200, height: 862))
    }

    @Test func tinyScreenNeverProducesNegativeGeometry() {
        let layout = WorkspaceShellLayoutCalculator.layout(
            in: CGRect(x: 5, y: 8, width: 100, height: 20),
            configuration: WorkspaceShellLayoutConfiguration(sidebarWidth: 240, topBarHeight: 38),
            pinned: [.sidebar, .topBar]
        )

        #expect(layout.sidebar.width == 100)
        #expect(layout.topBar.height == 20)
        #expect(layout.content.width == 0)
        #expect(layout.content.height == 0)
    }
}
