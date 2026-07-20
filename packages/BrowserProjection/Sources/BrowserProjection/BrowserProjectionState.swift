import Foundation

public struct BrowserProjectionState: Codable, Equatable, Sendable {
    public let type: String
    public let generation: Int
    public let projectedWindowId: Int?
    public let focusedWindowId: Int?
    public let extensionBuild: BrowserProjectionBuildIdentity
    public let windows: [BrowserProjectionWindow]

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case generation
        case projectedWindowId
        case focusedWindowId
        case extensionBuild = "extension"
        case windows
    }

    public init(
        generation: Int,
        projectedWindowId: Int?,
        focusedWindowId: Int?,
        extensionBuild: BrowserProjectionBuildIdentity,
        windows: [BrowserProjectionWindow]
    ) {
        type = "browser-state"
        self.generation = generation
        self.projectedWindowId = projectedWindowId
        self.focusedWindowId = focusedWindowId
        self.extensionBuild = extensionBuild
        self.windows = windows
    }

    public func validate() throws {
        guard type == "browser-state", generation >= 0 else {
            throw BrowserProjectionStateError.invalidHeader
        }
        guard windows.count <= 64 else { throw BrowserProjectionStateError.tooManyWindows }
        try extensionBuild.validate()

        let windowIds = Set(windows.map(\.id))
        guard windowIds.count == windows.count else { throw BrowserProjectionStateError.duplicateWindow }
        guard Set(windows.map(\.ordinal)).count == windows.count else {
            throw BrowserProjectionStateError.duplicateWindowOrdinal
        }
        guard windows.isEmpty == (projectedWindowId == nil) else {
            throw BrowserProjectionStateError.invalidProjection
        }
        if let projectedWindowId, !windowIds.contains(projectedWindowId) {
            throw BrowserProjectionStateError.unknownProjectedWindow
        }
        if let focusedWindowId, !windowIds.contains(focusedWindowId) {
            throw BrowserProjectionStateError.unknownFocusedWindow
        }
        guard windows.allSatisfy({ $0.focused == ($0.id == focusedWindowId) }) else {
            throw BrowserProjectionStateError.invalidFocusedWindow
        }
        for window in windows { try window.validate() }
    }
}

public struct BrowserProjectionBuildIdentity: Codable, Equatable, Sendable {
    public let version: String
    public let commits: Int?
    public let sha: String?
    public let dirty: Bool?

    public init(version: String, commits: Int? = nil, sha: String? = nil, dirty: Bool? = nil) {
        self.version = version
        self.commits = commits
        self.sha = sha
        self.dirty = dirty
    }

    fileprivate func validate() throws {
        guard !version.isEmpty, version.utf8.count <= 64,
              commits.map({ $0 >= 0 }) ?? true,
              sha.map({ $0.utf8.count <= 128 }) ?? true else {
            throw BrowserProjectionStateError.invalidBuildIdentity
        }
    }
}

public struct BrowserProjectionWindow: Codable, Equatable, Sendable {
    public let id: Int
    public let ordinal: Int
    public let focused: Bool
    public let state: String
    public let left: Int?
    public let top: Int?
    public let width: Int?
    public let height: Int?
    public let activeTabId: Int?
    public let tabs: [BrowserProjectionTab]
    public let groups: [BrowserProjectionGroup]

    public init(
        id: Int,
        ordinal: Int,
        focused: Bool,
        state: String = "normal",
        left: Int? = nil,
        top: Int? = nil,
        width: Int? = nil,
        height: Int? = nil,
        activeTabId: Int?,
        tabs: [BrowserProjectionTab],
        groups: [BrowserProjectionGroup] = []
    ) {
        self.id = id
        self.ordinal = ordinal
        self.focused = focused
        self.state = state
        self.left = left
        self.top = top
        self.width = width
        self.height = height
        self.activeTabId = activeTabId
        self.tabs = tabs
        self.groups = groups
    }

    fileprivate func validate() throws {
        guard id >= 0, ordinal > 0 else { throw BrowserProjectionStateError.invalidWindow }
        guard ["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen"].contains(state) else {
            throw BrowserProjectionStateError.invalidWindowState
        }
        guard width.map({ $0 > 0 }) ?? true,
              height.map({ $0 > 0 }) ?? true else {
            throw BrowserProjectionStateError.invalidWindow
        }
        guard tabs.count <= 512 else { throw BrowserProjectionStateError.tooManyTabs }
        guard groups.count <= 128 else { throw BrowserProjectionStateError.tooManyGroups }
        let tabIds = Set(tabs.map(\.id))
        let groupIds = Set(groups.map(\.id))
        guard tabIds.count == tabs.count else { throw BrowserProjectionStateError.duplicateTab }
        guard groupIds.count == groups.count else { throw BrowserProjectionStateError.duplicateGroup }
        guard tabs.allSatisfy({ $0.windowId == id }) else {
            throw BrowserProjectionStateError.crossWindowTab
        }
        if let activeTabId, !tabIds.contains(activeTabId) {
            throw BrowserProjectionStateError.unknownActiveTab
        }
        guard tabs.enumerated().allSatisfy({ $0.offset == $0.element.index }) else {
            throw BrowserProjectionStateError.invalidTabOrder
        }
        guard tabs.allSatisfy({ $0.groupId == -1 || groupIds.contains($0.groupId) }) else {
            throw BrowserProjectionStateError.unknownTabGroup
        }
        let activeTabs = tabs.filter(\.active)
        guard activeTabs.count == (activeTabId == nil ? 0 : 1),
              activeTabs.first?.id == activeTabId else {
            throw BrowserProjectionStateError.invalidActiveTab
        }
        for tab in tabs { try tab.validate() }
        for group in groups { try group.validate() }
    }
}

public struct BrowserProjectionTab: Codable, Equatable, Sendable {
    public let id: Int
    public let windowId: Int
    public let index: Int
    public let active: Bool
    public let pinned: Bool
    public let groupId: Int
    public let status: String
    public let title: String
    public let url: String
    public let favIconDataURL: String?
    public let audible: Bool
    public let muted: Bool
    public let discarded: Bool
    public let restricted: Bool

    public init(
        id: Int,
        windowId: Int,
        index: Int,
        active: Bool,
        pinned: Bool,
        groupId: Int = -1,
        status: String = "complete",
        title: String,
        url: String,
        favIconDataURL: String? = nil,
        audible: Bool = false,
        muted: Bool = false,
        discarded: Bool = false,
        restricted: Bool = false
    ) {
        self.id = id
        self.windowId = windowId
        self.index = index
        self.active = active
        self.pinned = pinned
        self.groupId = groupId
        self.status = status
        self.title = title
        self.url = url
        self.favIconDataURL = favIconDataURL
        self.audible = audible
        self.muted = muted
        self.discarded = discarded
        self.restricted = restricted
    }

    fileprivate func validate() throws {
        guard id >= 0, windowId >= 0, index >= 0, groupId >= -1 else {
            throw BrowserProjectionStateError.invalidTab
        }
        guard ["loading", "complete"].contains(status) else {
            throw BrowserProjectionStateError.invalidTabStatus
        }
        guard title.utf8.count <= 8_192,
              url.utf8.count <= 65_536 else {
            throw BrowserProjectionStateError.textTooLarge
        }
        if let favIconDataURL {
            let allowedPrefixes = [
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/webp;base64,",
                "data:image/gif;base64,",
                "data:image/x-icon;base64,",
                "data:image/vnd.microsoft.icon;base64,",
            ]
            guard favIconDataURL.utf8.count <= 128 * 1_024,
                  allowedPrefixes.contains(where: favIconDataURL.hasPrefix) else {
                throw BrowserProjectionStateError.invalidFavicon
            }
        }
    }
}

public struct BrowserProjectionGroup: Codable, Equatable, Sendable {
    public let id: Int
    public let title: String
    public let color: String
    public let collapsed: Bool

    public init(id: Int, title: String, color: String, collapsed: Bool) {
        self.id = id
        self.title = title
        self.color = color
        self.collapsed = collapsed
    }

    fileprivate func validate() throws {
        guard id >= 0 else { throw BrowserProjectionStateError.invalidGroup }
        guard title.utf8.count <= 1_024 else {
            throw BrowserProjectionStateError.textTooLarge
        }
        guard ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"].contains(color) else {
            throw BrowserProjectionStateError.invalidGroupColor
        }
    }
}

public struct BrowserProjectionBatchHeader: Decodable, Equatable, Sendable {
    public let type: String
    public let tabId: Int
    public let generation: Int
    public let checkout: Bool

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case tabId = "tb"
        case generation = "g"
        case checkout = "co"
    }
}

public struct BrowserProjectionSelectWindowCommand: Codable, Equatable, Sendable {
    public let type = "browser-select-window"
    public let windowId: Int
    public let generation: Int

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case windowId
        case generation
    }

    public init(windowId: Int, generation: Int) {
        self.windowId = windowId
        self.generation = generation
    }
}

public struct BrowserProjectionSelectTabCommand: Codable, Equatable, Sendable {
    public let type = "browser-select-tab"
    public let windowId: Int
    public let tabId: Int
    public let generation: Int

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case windowId
        case tabId
        case generation
    }

    public init(windowId: Int, tabId: Int, generation: Int) {
        self.windowId = windowId
        self.tabId = tabId
        self.generation = generation
    }
}

public struct BrowserProjectionHostState: Codable, Equatable, Sendable {
    public let type = "projection-host"
    public let connected: Bool
    public let sha: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case connected
        case sha
    }

    public init(connected: Bool, sha: String) {
        self.connected = connected
        self.sha = sha
    }
}

public enum BrowserProjectionStateError: Error, Equatable {
    case invalidHeader
    case tooManyWindows
    case duplicateWindow
    case duplicateWindowOrdinal
    case invalidProjection
    case unknownProjectedWindow
    case unknownFocusedWindow
    case invalidFocusedWindow
    case invalidBuildIdentity
    case invalidWindow
    case invalidWindowState
    case tooManyTabs
    case tooManyGroups
    case duplicateTab
    case duplicateGroup
    case crossWindowTab
    case unknownActiveTab
    case invalidActiveTab
    case invalidTabOrder
    case unknownTabGroup
    case invalidTab
    case invalidTabStatus
    case invalidGroup
    case invalidGroupColor
    case textTooLarge
    case invalidFavicon
}
