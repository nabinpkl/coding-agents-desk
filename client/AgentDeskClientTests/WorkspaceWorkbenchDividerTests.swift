import Testing
import UIKit

@testable import AgentDeskClient

@MainActor
struct WorkspaceWorkbenchDividerTests {
    @Test func dragDeltaIsPositiveWhenTheOwnedPaneGrows() {
        #expect(WorkspaceWorkbenchDivider.paneGrowthDelta(
            axis: .vertical,
            translation: CGPoint(x: 24, y: 0)
        ) == 24)
        #expect(WorkspaceWorkbenchDivider.paneGrowthDelta(
            axis: .horizontal,
            translation: CGPoint(x: 0, y: -24)
        ) == 24)
    }

    @Test func dragDeltaIsNegativeWhenTheOwnedPaneShrinks() {
        #expect(WorkspaceWorkbenchDivider.paneGrowthDelta(
            axis: .vertical,
            translation: CGPoint(x: -24, y: 0)
        ) == -24)
        #expect(WorkspaceWorkbenchDivider.paneGrowthDelta(
            axis: .horizontal,
            translation: CGPoint(x: 0, y: 24)
        ) == -24)
    }
}
