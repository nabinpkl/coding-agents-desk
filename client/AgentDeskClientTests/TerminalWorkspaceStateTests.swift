import Foundation
import PtyClientSwift
import Testing
import UIKit

struct TerminalWorkspaceStateTests {
    @Test func splitRightReplacesTargetLeafWithHorizontalSplit() {
        var state = TerminalWorkspaceState()

        let newLeaf = state.splitPane(TerminalPaneID(rawValue: 1), axis: .horizontal)

        #expect(newLeaf?.sessionName == "agentdesk-2")
        #expect(state.focusedPaneID == newLeaf?.paneID)
        switch state.root {
        case .split(let split):
            #expect(split.axis == .horizontal)
            #expect(split.first.leaf(for: TerminalPaneID(rawValue: 1))?.sessionName == "agentdesk-1")
            #expect(split.second.leaf(for: newLeaf?.paneID ?? TerminalPaneID(rawValue: -1))?.sessionName == "agentdesk-2")
        default:
            Issue.record("expected split root after split")
        }
    }

    @Test func splitDownNestedLeafOnlyRewritesTargetSubtree() {
        var state = TerminalWorkspaceState()
        let rightLeaf = state.splitPane(TerminalPaneID(rawValue: 1), axis: .horizontal)
        let nestedLeaf = state.splitPane(rightLeaf!.paneID, axis: .vertical)

        switch state.root {
        case .split(let outer):
            #expect(outer.axis == .horizontal)
            #expect(outer.first.leaf(for: TerminalPaneID(rawValue: 1))?.sessionName == "agentdesk-1")
            switch outer.second {
            case .split(let inner):
                #expect(inner.axis == .vertical)
                #expect(inner.first.leaf(for: rightLeaf!.paneID)?.sessionName == "agentdesk-2")
                #expect(inner.second.leaf(for: nestedLeaf!.paneID)?.sessionName == "agentdesk-3")
            default:
                Issue.record("expected nested split on target leaf")
            }
        default:
            Issue.record("expected outer split root")
        }
    }

    @Test func closeLeafCollapsesParentAndMovesFocusToSibling() {
        var state = TerminalWorkspaceState()
        let rightLeaf = state.splitPane(TerminalPaneID(rawValue: 1), axis: .horizontal)!
        let lowerLeaf = state.splitPane(rightLeaf.paneID, axis: .vertical)!

        let closeResult = state.closePane(lowerLeaf.paneID)

        #expect(closeResult == .removed(lowerLeaf))
        #expect(state.focusedPaneID == rightLeaf.paneID)
        switch state.root {
        case .split(let split):
            #expect(split.axis == .horizontal)
            #expect(split.first.leaf(for: TerminalPaneID(rawValue: 1))?.sessionName == "agentdesk-1")
            #expect(split.second.leaf(for: rightLeaf.paneID)?.sessionName == "agentdesk-2")
        default:
            Issue.record("expected collapsed outer split")
        }
    }

    @Test func closeUnfocusedLeafPreservesCurrentFocus() {
        var state = TerminalWorkspaceState()
        let second = state.splitPane(TerminalPaneID(rawValue: 1), axis: .horizontal)!
        let third = state.splitPane(second.paneID, axis: .vertical)!
        let didFocusFirstPane = state.focusPane(TerminalPaneID(rawValue: 1))
        #expect(didFocusFirstPane)

        let closeResult = state.closePane(third.paneID)

        #expect(closeResult == .removed(third))
        #expect(state.focusedPaneID == TerminalPaneID(rawValue: 1))
    }

    @Test func focusPaneRejectsUnknownPane() {
        var state = TerminalWorkspaceState()

        let changed = state.focusPane(TerminalPaneID(rawValue: 99))

        #expect(!changed)
        #expect(state.focusedPaneID == TerminalPaneID(rawValue: 1))
    }

    @Test func closeLastPaneResetsToFreshPane() {
        var state = TerminalWorkspaceState()

        let closeResult = state.closePane(TerminalPaneID(rawValue: 1))

        #expect(closeResult == .reset(
            removed: TerminalPaneLeaf(paneID: TerminalPaneID(rawValue: 1), sessionName: "agentdesk-1"),
            replacement: TerminalPaneLeaf(paneID: TerminalPaneID(rawValue: 2), sessionName: "agentdesk-2")
        ))
        #expect(state.leafCount == 1)
        #expect(state.focusedPaneID == TerminalPaneID(rawValue: 2))
        #expect(state.leaf(for: TerminalPaneID(rawValue: 2))?.sessionName == "agentdesk-2")
    }

    @Test func openExistingSessionSplitsFocusedPaneWithoutCreatingNewSessionName() {
        var state = TerminalWorkspaceState()
        let second = state.splitPane(TerminalPaneID(rawValue: 1), axis: .horizontal)!

        let joined = state.openExistingSession("tmux-work")

        #expect(joined?.sessionName == "tmux-work")
        #expect(joined?.createIfMissing == false)
        #expect(state.focusedPaneID == joined?.paneID)
        switch state.root {
        case .split(let outer):
            switch outer.second {
            case .split(let inner):
                #expect(inner.first.leaf(for: second.paneID)?.sessionName == "agentdesk-2")
                #expect(inner.second.leaf(for: joined?.paneID ?? TerminalPaneID(rawValue: -1))?.sessionName == "tmux-work")
            default:
                Issue.record("expected existing session to split the focused pane")
            }
        default:
            Issue.record("expected split root after opening existing session")
        }
    }

    @Test func openExistingSessionDoesNotAdvanceFreshSessionOrdinal() {
        var state = TerminalWorkspaceState()
        let joined = state.openExistingSession("host-owned")!

        let fresh = state.splitPane(joined.paneID, axis: .vertical)

        #expect(fresh?.sessionName == "agentdesk-2")
        #expect(fresh?.createIfMissing == true)
    }

    @Test func sessionNamesStayUniqueAndMonotonic() {
        var state = TerminalWorkspaceState()
        let second = state.splitPane(TerminalPaneID(rawValue: 1), axis: .horizontal)!
        let third = state.splitPane(second.paneID, axis: .vertical)!
        let fourth = state.splitPane(third.paneID, axis: .horizontal)!

        let sessions = state.allLeaves().map(\.sessionName).sorted()

        #expect(sessions == ["agentdesk-1", "agentdesk-2", "agentdesk-3", "agentdesk-4"])
        #expect(fourth.sessionName == "agentdesk-4")
    }
}

@MainActor
struct TerminalPaneViewCloseTests {
    @Test func closeSingleClientKillsSession() async {
        let pane = TerminalPaneView(leaf: TerminalPaneLeaf(
            paneID: TerminalPaneID(rawValue: 1),
            sessionName: "agentdesk-1"
        ))
        let connection = FakeTerminalPaneSessionConnection(clientCount: 1)
        pane.attach(connection)

        let result = await pane.closeForUser()

        #expect(result == .killed)
        #expect(connection.killCallCount == 1)
        #expect(connection.detachCallCount == 0)
    }

    @Test func closeMultipleClientSessionDetachesOnlyThisClient() async {
        let pane = TerminalPaneView(leaf: TerminalPaneLeaf(
            paneID: TerminalPaneID(rawValue: 1),
            sessionName: "agentdesk-1"
        ))
        let connection = FakeTerminalPaneSessionConnection(clientCount: 2)
        pane.attach(connection)

        let result = await pane.closeForUser()

        #expect(result == .detached)
        #expect(connection.killCallCount == 0)
        #expect(connection.detachCallCount == 1)
    }
}

#if DEBUG
@available(iOS 26.0, *)
@MainActor
struct TerminalSurfaceLifecycleTests {
    @Test func detachPreservesWorkspaceAndPaneViewsForReconnect() {
        let surface = TerminalSurface()
        surface.debugSplitFocusedPaneForTesting(axis: .horizontal)
        let paneIDsBeforeDetach = surface.debugPaneViewIDsForTesting()

        surface.detach()

        #expect(surface.debugWorkspaceLeafCountForTesting() == 2)
        #expect(surface.debugPaneViewIDsForTesting() == paneIDsBeforeDetach)
    }
}
#endif

private final class FakeTerminalPaneSessionConnection: TerminalPaneSessionConnection, @unchecked Sendable {
    let sessionName = "agentdesk-1"
    let attachedClientCount: UInt32
    let attachedClientID: UInt64 = 42
    private(set) var detachCallCount = 0
    private(set) var killCallCount = 0

    init(clientCount: UInt32) {
        attachedClientCount = clientCount
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish()
        }
    }

    func sendInput(_ data: Data) async throws {}

    func resize(columns: UInt32, rows: UInt32) async throws {}

    func detach() async throws {
        detachCallCount += 1
    }

    func kill() async throws {
        killCallCount += 1
    }
}
