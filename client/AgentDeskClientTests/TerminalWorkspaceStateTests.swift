import Testing

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

        let removed = state.closePane(lowerLeaf.paneID)

        #expect(removed == lowerLeaf)
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

    @Test func focusPaneRejectsUnknownPane() {
        var state = TerminalWorkspaceState()

        let changed = state.focusPane(TerminalPaneID(rawValue: 99))

        #expect(!changed)
        #expect(state.focusedPaneID == TerminalPaneID(rawValue: 1))
    }

    @Test func closeLastPaneIsRejected() {
        var state = TerminalWorkspaceState()

        let removed = state.closePane(TerminalPaneID(rawValue: 1))

        #expect(removed == nil)
        #expect(state.leafCount == 1)
        #expect(state.focusedPaneID == TerminalPaneID(rawValue: 1))
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
