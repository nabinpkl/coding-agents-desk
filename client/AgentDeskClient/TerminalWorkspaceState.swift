import CoreGraphics
import Foundation

enum TerminalSplitAxis: String, Equatable {
    case horizontal
    case vertical
}

struct TerminalPaneID: Hashable, Equatable {
    let rawValue: Int
}

struct TerminalPaneLeaf: Equatable {
    let paneID: TerminalPaneID
    let sessionName: String
    let createIfMissing: Bool

    init(paneID: TerminalPaneID, sessionName: String, createIfMissing: Bool = true) {
        self.paneID = paneID
        self.sessionName = sessionName
        self.createIfMissing = createIfMissing
    }
}

indirect enum TerminalPaneNode: Equatable {
    case leaf(TerminalPaneLeaf)
    case split(TerminalPaneSplit)

    var firstLeaf: TerminalPaneLeaf {
        switch self {
        case .leaf(let leaf):
            return leaf
        case .split(let split):
            return split.first.firstLeaf
        }
    }

    var leafCount: Int {
        switch self {
        case .leaf:
            return 1
        case .split(let split):
            return split.first.leafCount + split.second.leafCount
        }
    }

    func contains(_ paneID: TerminalPaneID) -> Bool {
        switch self {
        case .leaf(let leaf):
            return leaf.paneID == paneID
        case .split(let split):
            return split.first.contains(paneID) || split.second.contains(paneID)
        }
    }

    func leaf(for paneID: TerminalPaneID) -> TerminalPaneLeaf? {
        switch self {
        case .leaf(let leaf):
            return leaf.paneID == paneID ? leaf : nil
        case .split(let split):
            return split.first.leaf(for: paneID) ?? split.second.leaf(for: paneID)
        }
    }
}

struct TerminalPaneSplit: Equatable {
    let axis: TerminalSplitAxis
    let ratio: CGFloat
    let first: TerminalPaneNode
    let second: TerminalPaneNode
}

enum TerminalPaneCloseResult: Equatable {
    case removed(TerminalPaneLeaf)
    case reset(removed: TerminalPaneLeaf, replacement: TerminalPaneLeaf)
}

struct TerminalWorkspaceState: Equatable {
    private(set) var root: TerminalPaneNode
    private(set) var focusedPaneID: TerminalPaneID
    private var nextPaneOrdinal: Int
    private var nextSessionOrdinal: Int

    init() {
        let firstPane = TerminalPaneLeaf(paneID: TerminalPaneID(rawValue: 1), sessionName: "agentdesk-1")
        root = .leaf(firstPane)
        focusedPaneID = firstPane.paneID
        nextPaneOrdinal = 2
        nextSessionOrdinal = 2
    }

    var leafCount: Int {
        root.leafCount
    }

    func leaf(for paneID: TerminalPaneID) -> TerminalPaneLeaf? {
        root.leaf(for: paneID)
    }

    func allLeaves() -> [TerminalPaneLeaf] {
        collectLeaves(in: root)
    }

    mutating func focusPane(_ paneID: TerminalPaneID) -> Bool {
        guard root.contains(paneID) else { return false }
        focusedPaneID = paneID
        return true
    }

    mutating func splitPane(_ paneID: TerminalPaneID, axis: TerminalSplitAxis) -> TerminalPaneLeaf? {
        guard root.contains(paneID) else { return nil }
        let newLeaf = makeFreshSessionLeaf()
        guard let updatedRoot = split(node: root, target: paneID, axis: axis, newLeaf: newLeaf) else {
            return nil
        }
        root = updatedRoot
        focusedPaneID = newLeaf.paneID
        return newLeaf
    }

    mutating func openExistingSession(_ sessionName: String, axis: TerminalSplitAxis = .horizontal) -> TerminalPaneLeaf? {
        let normalizedName = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty, root.contains(focusedPaneID) else { return nil }
        let newLeaf = makeExistingSessionLeaf(sessionName: normalizedName)
        guard let updatedRoot = split(node: root, target: focusedPaneID, axis: axis, newLeaf: newLeaf) else {
            return nil
        }
        root = updatedRoot
        focusedPaneID = newLeaf.paneID
        return newLeaf
    }

    mutating func closePane(_ paneID: TerminalPaneID) -> TerminalPaneCloseResult? {
        guard let removedLeaf = root.leaf(for: paneID) else { return nil }
        if leafCount == 1 {
            let replacementLeaf = makeFreshSessionLeaf()
            root = .leaf(replacementLeaf)
            focusedPaneID = replacementLeaf.paneID
            return .reset(removed: removedLeaf, replacement: replacementLeaf)
        }

        let previousFocus = focusedPaneID
        guard let result = remove(node: root, target: paneID) else { return nil }
        root = result.node
        focusedPaneID = root.contains(previousFocus) ? previousFocus : result.focusPaneID
        return .removed(removedLeaf)
    }

    private func collectLeaves(in node: TerminalPaneNode) -> [TerminalPaneLeaf] {
        switch node {
        case .leaf(let leaf):
            return [leaf]
        case .split(let split):
            return collectLeaves(in: split.first) + collectLeaves(in: split.second)
        }
    }

    private func split(
        node: TerminalPaneNode,
        target: TerminalPaneID,
        axis: TerminalSplitAxis,
        newLeaf: TerminalPaneLeaf
    ) -> TerminalPaneNode? {
        switch node {
        case .leaf(let leaf):
            guard leaf.paneID == target else { return nil }
            return .split(
                TerminalPaneSplit(
                    axis: axis,
                    ratio: 0.5,
                    first: .leaf(leaf),
                    second: .leaf(newLeaf)
                )
            )
        case .split(let splitNode):
            if let updatedFirst = split(node: splitNode.first, target: target, axis: axis, newLeaf: newLeaf) {
                return .split(
                    TerminalPaneSplit(
                        axis: splitNode.axis,
                        ratio: splitNode.ratio,
                        first: updatedFirst,
                        second: splitNode.second
                    )
                )
            }
            if let updatedSecond = split(node: splitNode.second, target: target, axis: axis, newLeaf: newLeaf) {
                return .split(
                    TerminalPaneSplit(
                        axis: splitNode.axis,
                        ratio: splitNode.ratio,
                        first: splitNode.first,
                        second: updatedSecond
                    )
                )
            }
            return nil
        }
    }

    private func remove(node: TerminalPaneNode, target: TerminalPaneID) -> RemovalResult? {
        switch node {
        case .leaf(let leaf):
            return leaf.paneID == target ? nil : RemovalResult(node: .leaf(leaf), focusPaneID: leaf.paneID)
        case .split(let splitNode):
            if splitNode.first.contains(target) {
                if let updatedFirst = remove(node: splitNode.first, target: target) {
                    return RemovalResult(
                        node: .split(
                            TerminalPaneSplit(
                                axis: splitNode.axis,
                                ratio: splitNode.ratio,
                                first: updatedFirst.node,
                                second: splitNode.second
                            )
                        ),
                        focusPaneID: updatedFirst.focusPaneID
                    )
                }
                return RemovalResult(node: splitNode.second, focusPaneID: splitNode.second.firstLeaf.paneID)
            }
            if splitNode.second.contains(target) {
                if let updatedSecond = remove(node: splitNode.second, target: target) {
                    return RemovalResult(
                        node: .split(
                            TerminalPaneSplit(
                                axis: splitNode.axis,
                                ratio: splitNode.ratio,
                                first: splitNode.first,
                                second: updatedSecond.node
                            )
                        ),
                        focusPaneID: updatedSecond.focusPaneID
                    )
                }
                return RemovalResult(node: splitNode.first, focusPaneID: splitNode.first.firstLeaf.paneID)
            }
            return nil
        }
    }

    private mutating func makeFreshSessionLeaf() -> TerminalPaneLeaf {
        let leaf = TerminalPaneLeaf(
            paneID: TerminalPaneID(rawValue: nextPaneOrdinal),
            sessionName: "agentdesk-\(nextSessionOrdinal)",
            createIfMissing: true
        )
        nextPaneOrdinal += 1
        nextSessionOrdinal += 1
        return leaf
    }

    private mutating func makeExistingSessionLeaf(sessionName: String) -> TerminalPaneLeaf {
        let leaf = TerminalPaneLeaf(
            paneID: TerminalPaneID(rawValue: nextPaneOrdinal),
            sessionName: sessionName,
            createIfMissing: false
        )
        nextPaneOrdinal += 1
        return leaf
    }
}

private struct RemovalResult {
    let node: TerminalPaneNode
    let focusPaneID: TerminalPaneID
}
