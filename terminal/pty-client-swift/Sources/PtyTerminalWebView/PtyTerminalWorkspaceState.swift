import Foundation

public enum PtyTerminalWebViewProfile: String, Codable, Sendable {
    case workspace
    case singleSession
}

public enum PtyTerminalSplitAxis: String, Codable, Sendable {
    case horizontal
    case vertical
}

public struct PtyTerminalPane: Codable, Equatable, Sendable {
    public let paneID: String
    public let terminalID: String
    public var sessionName: String
    public var title: String
    public var createIfMissing: Bool

    public init(
        paneID: String,
        terminalID: String,
        sessionName: String,
        title: String,
        createIfMissing: Bool
    ) {
        self.paneID = paneID
        self.terminalID = terminalID
        self.sessionName = sessionName
        self.title = title
        self.createIfMissing = createIfMissing
    }
}

public indirect enum PtyTerminalPaneNode: Codable, Equatable, Sendable {
    case pane(PtyTerminalPane)
    case split(axis: PtyTerminalSplitAxis, first: PtyTerminalPaneNode, second: PtyTerminalPaneNode)

    var panes: [PtyTerminalPane] {
        switch self {
        case .pane(let pane): [pane]
        case .split(_, let first, let second): first.panes + second.panes
        }
    }

    func replacing(_ paneID: String, with replacement: PtyTerminalPaneNode) -> Self? {
        switch self {
        case .pane(let pane): return pane.paneID == paneID ? replacement : nil
        case .split(let axis, let first, let second):
            if let updated = first.replacing(paneID, with: replacement) {
                return .split(axis: axis, first: updated, second: second)
            }
            if let updated = second.replacing(paneID, with: replacement) {
                return .split(axis: axis, first: first, second: updated)
            }
            return nil
        }
    }

    func removing(_ paneID: String) -> (node: Self?, removed: PtyTerminalPane)? {
        switch self {
        case .pane(let pane): return pane.paneID == paneID ? (nil, pane) : nil
        case .split(_, let first, let second):
            if let result = first.removing(paneID) {
                return (result.node ?? second, result.removed)
            }
            if let result = second.removing(paneID) {
                return (result.node ?? first, result.removed)
            }
            return nil
        }
    }
}

public struct PtyTerminalWorkspaceTab: Codable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var root: PtyTerminalPaneNode
    public var focusedPaneID: String
}

public struct PtyTerminalWorkspaceState: Codable, Equatable, Sendable {
    public static let maximumTabs = 16
    public static let maximumPanes = 16

    public let profile: PtyTerminalWebViewProfile
    public private(set) var tabs: [PtyTerminalWorkspaceTab]
    public private(set) var selectedTabID: String
    private var nextOrdinal: UInt64

    public init(profile: PtyTerminalWebViewProfile = .workspace) {
        let pane = Self.makePane(ordinal: 1, sessionName: "", createIfMissing: true)
        let tab = PtyTerminalWorkspaceTab(id: "tab-1", title: "Terminal 1", root: .pane(pane), focusedPaneID: pane.paneID)
        self.profile = profile
        tabs = [tab]
        selectedTabID = tab.id
        nextOrdinal = 2
    }

    public init(restoringSessionName sessionName: String) {
        self.init(profile: .workspace)
        _ = assignSessionName(sessionName, to: tabs[0].focusedPaneID)
    }

    private enum CodingKeys: String, CodingKey {
        case profile, tabs, selectedTabID, nextOrdinal
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedProfile = try values.decode(PtyTerminalWebViewProfile.self, forKey: .profile)
        let decodedTabs = try values.decode([PtyTerminalWorkspaceTab].self, forKey: .tabs)
        let decodedSelectedTabID = try values.decode(String.self, forKey: .selectedTabID)
        let decodedNextOrdinal = try values.decode(UInt64.self, forKey: .nextOrdinal)
        guard Self.isValid(
            profile: decodedProfile,
            tabs: decodedTabs,
            selectedTabID: decodedSelectedTabID
        ) else {
            throw DecodingError.dataCorruptedError(
                forKey: .tabs,
                in: values,
                debugDescription: "invalid bounded terminal workspace"
            )
        }
        profile = decodedProfile
        tabs = decodedTabs
        selectedTabID = decodedSelectedTabID
        nextOrdinal = max(2, decodedNextOrdinal)
    }

    public var panes: [PtyTerminalPane] { tabs.flatMap { $0.root.panes } }
    public var selectedPane: PtyTerminalPane? {
        guard let tab = tabs.first(where: { $0.id == selectedTabID }) else { return nil }
        return tab.root.panes.first(where: { $0.paneID == tab.focusedPaneID })
    }
    public var visiblePanes: [PtyTerminalPane] {
        tabs.first(where: { $0.id == selectedTabID })?.root.panes ?? []
    }

    @discardableResult
    public mutating func addTab() -> PtyTerminalPane? {
        guard profile == .workspace, tabs.count < Self.maximumTabs, panes.count < Self.maximumPanes else { return nil }
        let pane = freshPane()
        let tab = PtyTerminalWorkspaceTab(id: "tab-\(nextOrdinal)", title: "Terminal \(tabs.count + 1)", root: .pane(pane), focusedPaneID: pane.paneID)
        nextOrdinal += 1
        tabs.append(tab)
        selectedTabID = tab.id
        return pane
    }

    @discardableResult
    public mutating func splitFocusedPane(axis: PtyTerminalSplitAxis) -> PtyTerminalPane? {
        guard profile == .workspace, panes.count < Self.maximumPanes,
              let tabIndex = tabs.firstIndex(where: { $0.id == selectedTabID }) else { return nil }
        let focused = tabs[tabIndex].focusedPaneID
        guard let existing = tabs[tabIndex].root.panes.first(where: { $0.paneID == focused }) else { return nil }
        let pane = freshPane()
        let replacement = PtyTerminalPaneNode.split(
            axis: axis,
            first: .pane(existing),
            second: .pane(pane)
        )
        guard let root = tabs[tabIndex].root.replacing(focused, with: replacement) else { return nil }
        tabs[tabIndex].root = root
        tabs[tabIndex].focusedPaneID = pane.paneID
        return pane
    }

    @discardableResult
    public mutating func openExistingSession(_ sessionName: String) -> PtyTerminalPane? {
        guard profile == .workspace, tabs.count < Self.maximumTabs, panes.count < Self.maximumPanes else { return nil }
        let normalized = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.utf8.count <= 256 else { return nil }
        var pane = freshPane()
        pane.sessionName = normalized
        pane.title = normalized
        pane.createIfMissing = false
        let tab = PtyTerminalWorkspaceTab(id: "tab-\(nextOrdinal)", title: normalized, root: .pane(pane), focusedPaneID: pane.paneID)
        nextOrdinal += 1
        tabs.append(tab)
        selectedTabID = tab.id
        return pane
    }

    public mutating func selectTab(_ tabID: String) -> Bool {
        guard tabs.contains(where: { $0.id == tabID }) else { return false }
        selectedTabID = tabID
        return true
    }

    @discardableResult
    public mutating func closeTab(_ tabID: String) -> [PtyTerminalPane]? {
        guard profile == .workspace,
              let tabIndex = tabs.firstIndex(where: { $0.id == tabID }) else { return nil }
        let removed = tabs[tabIndex].root.panes
        if tabs.count > 1 {
            tabs.remove(at: tabIndex)
            if selectedTabID == tabID {
                selectedTabID = tabs[min(tabIndex, tabs.count - 1)].id
            }
        } else {
            let replacement = freshPane()
            tabs[0].root = .pane(replacement)
            tabs[0].focusedPaneID = replacement.paneID
            tabs[0].title = "Terminal"
        }
        return removed
    }

    public mutating func focusPane(_ paneID: String) -> Bool {
        guard let tabIndex = tabs.firstIndex(where: { $0.root.panes.contains(where: { $0.paneID == paneID }) }) else { return false }
        selectedTabID = tabs[tabIndex].id
        tabs[tabIndex].focusedPaneID = paneID
        return true
    }

    public mutating func closePane(_ paneID: String) -> PtyTerminalPane? {
        guard profile == .workspace,
              let tabIndex = tabs.firstIndex(where: { $0.root.panes.contains(where: { $0.paneID == paneID }) }),
              let removal = tabs[tabIndex].root.removing(paneID) else { return nil }
        if let remaining = removal.node {
            tabs[tabIndex].root = remaining
            tabs[tabIndex].focusedPaneID = remaining.panes[0].paneID
        } else if tabs.count > 1 {
            tabs.remove(at: tabIndex)
            selectedTabID = tabs[min(tabIndex, tabs.count - 1)].id
        } else {
            let replacement = freshPane()
            tabs[0].root = .pane(replacement)
            tabs[0].focusedPaneID = replacement.paneID
            tabs[0].title = "Terminal"
        }
        return removal.removed
    }

    public mutating func bindSingleSession(name: String, title: String) -> PtyTerminalPane {
        precondition(profile == .singleSession)
        var pane = tabs[0].root.panes[0]
        pane.sessionName = name
        pane.title = title
        pane.createIfMissing = false
        tabs[0].root = .pane(pane)
        tabs[0].focusedPaneID = pane.paneID
        tabs[0].title = title
        return pane
    }

    public mutating func assignSessionName(_ name: String, to paneID: String) -> PtyTerminalPane? {
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.utf8.count <= 256,
              let tabIndex = tabs.firstIndex(where: { $0.root.panes.contains(where: { $0.paneID == paneID }) }),
              var pane = tabs[tabIndex].root.panes.first(where: { $0.paneID == paneID }) else { return nil }
        pane.sessionName = normalized
        pane.title = normalized
        guard let root = tabs[tabIndex].root.replacing(paneID, with: .pane(pane)) else { return nil }
        tabs[tabIndex].root = root
        if case .pane = root { tabs[tabIndex].title = normalized }
        return pane
    }

    public func snapshotObject() -> [String: Any] {
        [
            "version": 1,
            "profile": profile.rawValue,
            "selectedTabId": selectedTabID,
            "tabs": tabs.map { tab in
                ["id": tab.id, "title": tab.title, "focusedPaneId": tab.focusedPaneID, "root": Self.nodeObject(tab.root)]
            },
        ]
    }

    private mutating func freshPane() -> PtyTerminalPane {
        let pane = Self.makePane(ordinal: nextOrdinal, sessionName: "", createIfMissing: true)
        nextOrdinal += 1
        return pane
    }

    private static func makePane(ordinal: UInt64, sessionName: String, createIfMissing: Bool) -> PtyTerminalPane {
        PtyTerminalPane(
            paneID: "pane-\(ordinal)", terminalID: "terminal-\(UUID().uuidString.lowercased())",
            sessionName: sessionName, title: sessionName.isEmpty ? "Terminal" : sessionName,
            createIfMissing: createIfMissing
        )
    }

    private static func nodeObject(_ node: PtyTerminalPaneNode) -> [String: Any] {
        switch node {
        case .pane(let pane):
            ["kind": "pane", "paneId": pane.paneID, "terminalId": pane.terminalID, "title": pane.title]
        case .split(let axis, let first, let second):
            ["kind": "split", "axis": axis.rawValue, "first": nodeObject(first), "second": nodeObject(second)]
        }
    }


    private static func isValid(
        profile: PtyTerminalWebViewProfile,
        tabs: [PtyTerminalWorkspaceTab],
        selectedTabID: String
    ) -> Bool {
        guard !tabs.isEmpty, tabs.count <= maximumTabs,
              tabs.contains(where: { $0.id == selectedTabID }) else { return false }
        let allPanes = tabs.flatMap { $0.root.panes }
        guard !allPanes.isEmpty, allPanes.count <= maximumPanes,
              Set(tabs.map(\.id)).count == tabs.count,
              Set(allPanes.map(\.paneID)).count == allPanes.count,
              Set(allPanes.map(\.terminalID)).count == allPanes.count else { return false }
        guard tabs.allSatisfy({ tab in
            !tab.id.isEmpty && tab.id.utf8.count <= 128 &&
                !tab.title.isEmpty && tab.title.utf8.count <= 256 &&
                tab.root.panes.contains(where: { $0.paneID == tab.focusedPaneID })
        }) else { return false }
        guard allPanes.allSatisfy({ pane in
            !pane.paneID.isEmpty && pane.paneID.utf8.count <= 128 &&
                !pane.terminalID.isEmpty && pane.terminalID.utf8.count <= 128 &&
                pane.sessionName.utf8.count <= 256 && pane.title.utf8.count <= 256
        }) else { return false }
        return profile == .workspace || (tabs.count == 1 && allPanes.count == 1)
    }
}
