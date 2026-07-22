import XCTest
@testable import PtyTerminalWebView

final class PtyTerminalWorkspaceStateTests: XCTestCase {
    func testRecursiveSplitAndTabStateRemainBoundedAndNeverEmpty() {
        var state = PtyTerminalWorkspaceState(profile: .workspace)
        let original = try! XCTUnwrap(state.selectedPane)
        let second = try! XCTUnwrap(state.splitFocusedPane(axis: .horizontal))
        XCTAssertEqual(state.panes.count, 2)
        XCTAssertEqual(state.visiblePanes.count, 2)
        XCTAssertNotEqual(original.paneID, second.paneID)
        XCTAssertEqual(state.selectedPane?.paneID, second.paneID)

        _ = state.closePane(second.paneID)
        XCTAssertEqual(state.panes.map(\.paneID), [original.paneID])
        _ = state.closePane(original.paneID)
        XCTAssertEqual(state.panes.count, 1)
        XCTAssertNotEqual(state.selectedPane?.paneID, original.paneID)
    }

    func testExistingSessionOpensInNewTabWithoutMutationAuthority() {
        var state = PtyTerminalWorkspaceState(profile: .workspace)
        let pane = state.openExistingSession("shared-session")
        XCTAssertEqual(pane?.sessionName, "shared-session")
        XCTAssertEqual(pane?.createIfMissing, false)
        XCTAssertEqual(state.tabs.count, 2)
    }

    func testSingleSessionRejectsManagementOperations() {
        var state = PtyTerminalWorkspaceState(profile: .singleSession)
        XCTAssertNil(state.addTab())
        XCTAssertNil(state.splitFocusedPane(axis: .vertical))
    }

    func testBoundedWorkspaceRoundTripsForMetadataRestoration() throws {
        var state = PtyTerminalWorkspaceState(restoringSessionName: "first")
        let second = try XCTUnwrap(state.splitFocusedPane(axis: .vertical))
        _ = state.assignSessionName("second", to: second.paneID)

        let restored = try JSONDecoder().decode(
            PtyTerminalWorkspaceState.self,
            from: JSONEncoder().encode(state)
        )

        XCTAssertEqual(restored, state)
        XCTAssertEqual(restored.panes.map(\.sessionName), ["first", "second"])
    }

    func testClosingTabRemovesEveryPaneAndKeepsWorkspaceNonempty() throws {
        var state = PtyTerminalWorkspaceState(profile: .workspace)
        let originalTabID = state.selectedTabID
        _ = try XCTUnwrap(state.splitFocusedPane(axis: .horizontal))
        let removed = try XCTUnwrap(state.closeTab(originalTabID))

        XCTAssertEqual(removed.count, 2)
        XCTAssertEqual(state.tabs.count, 1)
        XCTAssertEqual(state.panes.count, 1)
        XCTAssertFalse(removed.map(\.paneID).contains(state.selectedPane?.paneID ?? ""))

        let secondTabPane = try XCTUnwrap(state.addTab())
        let secondTabID = state.selectedTabID
        let removedSecond = try XCTUnwrap(state.closeTab(secondTabID))
        XCTAssertEqual(removedSecond.map(\.paneID), [secondTabPane.paneID])
        XCTAssertEqual(state.tabs.map(\.id), [originalTabID])
    }
}
