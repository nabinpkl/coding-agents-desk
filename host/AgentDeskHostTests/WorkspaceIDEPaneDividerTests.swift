import AppKit
import Testing

@testable import AgentDeskHost

@MainActor
struct WorkspaceIDEPaneDividerTests {
    @Test func dragDeltaIsPositiveWhenTheOwnedPaneGrows() {
        #expect(WorkspaceIDEPaneDivider.paneGrowthDelta(
            axis: .vertical,
            translation: NSPoint(x: 24, y: 0)
        ) == 24)
        #expect(WorkspaceIDEPaneDivider.paneGrowthDelta(
            axis: .horizontal,
            translation: NSPoint(x: 0, y: 24)
        ) == 24)
    }

    @Test func dragDeltaIsNegativeWhenTheOwnedPaneShrinks() {
        #expect(WorkspaceIDEPaneDivider.paneGrowthDelta(
            axis: .vertical,
            translation: NSPoint(x: -24, y: 0)
        ) == -24)
        #expect(WorkspaceIDEPaneDivider.paneGrowthDelta(
            axis: .horizontal,
            translation: NSPoint(x: 0, y: -24)
        ) == -24)
    }
}
