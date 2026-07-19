import Foundation

enum WorkspaceIDEWebRegion: String, Equatable, Sendable {
    case sidebar
    case editor
}

enum WorkspaceIDEWebIntent: Equatable, Sendable {
    case ready(region: WorkspaceIDEWebRegion)
    case selectWorkspace(id: String)
    case selectSidebarSection(WorkspaceIDESidebarSection)
    case open(path: String)
    case close(path: String)
    case reorderTabs(paths: [String])
    case setDirectoryExpanded(path: String, expanded: Bool)
    case selectTab(path: String)
    case toggleMode(path: String)
    case edit(path: String, text: String)
    case useHost(path: String)
    case keepMine(path: String)
    case zoomIn
    case zoomOut
    case setSidebarVisible(Bool)
    case setTerminalVisible(Bool)
    case addWorkspace
    case removeWorkspace(id: String)
    case reorderWorkspaces(ids: [String])
    case assignDesktop(id: String)
    case setAutoAssignDesktop(id: String, enabled: Bool)

    enum ParseError: Error, Equatable {
        case notDictionary
        case missing(String)
        case invalid(String)
        case unknownType(String)
    }

    static func parse(_ body: Any) throws -> Self {
        guard let message = body as? [String: Any] else { throw ParseError.notDictionary }
        let type = try string("type", in: message)
        switch type {
        case "ready":
            guard let region = WorkspaceIDEWebRegion(rawValue: try string("region", in: message)) else {
                throw ParseError.invalid("region")
            }
            return .ready(region: region)
        case "selectWorkspace": return .selectWorkspace(id: try string("id", in: message))
        case "selectSidebarSection":
            guard let section = WorkspaceIDESidebarSection(rawValue: try string("section", in: message)) else {
                throw ParseError.invalid("section")
            }
            return .selectSidebarSection(section)
        case "open": return .open(path: try string("path", in: message))
        case "close": return .close(path: try string("path", in: message))
        case "reorderTabs": return .reorderTabs(paths: try strings("paths", in: message))
        case "setDirectoryExpanded":
            return .setDirectoryExpanded(
                path: try string("path", in: message),
                expanded: try bool("expanded", in: message)
            )
        case "selectTab": return .selectTab(path: try string("path", in: message))
        case "toggleMode": return .toggleMode(path: try string("path", in: message))
        case "edit": return .edit(path: try string("path", in: message), text: try string("text", in: message))
        case "useHost": return .useHost(path: try string("path", in: message))
        case "keepMine": return .keepMine(path: try string("path", in: message))
        case "zoomIn": return .zoomIn
        case "zoomOut": return .zoomOut
        case "setSidebarVisible": return .setSidebarVisible(try bool("visible", in: message))
        case "setTerminalVisible": return .setTerminalVisible(try bool("visible", in: message))
        case "addWorkspace": return .addWorkspace
        case "removeWorkspace": return .removeWorkspace(id: try string("id", in: message))
        case "reorderWorkspaces": return .reorderWorkspaces(ids: try strings("ids", in: message))
        case "assignDesktop": return .assignDesktop(id: try string("id", in: message))
        case "setAutoAssignDesktop":
            return .setAutoAssignDesktop(
                id: try string("id", in: message),
                enabled: try bool("enabled", in: message)
            )
        default: throw ParseError.unknownType(type)
        }
    }

    private static func string(_ key: String, in message: [String: Any]) throws -> String {
        guard let value = message[key] as? String, !value.isEmpty else { throw ParseError.missing(key) }
        return value
    }

    private static func strings(_ key: String, in message: [String: Any]) throws -> [String] {
        guard let value = message[key] as? [String], value.allSatisfy({ !$0.isEmpty }) else {
            throw ParseError.invalid(key)
        }
        return value
    }

    private static func bool(_ key: String, in message: [String: Any]) throws -> Bool {
        guard let value = message[key] as? Bool else { throw ParseError.invalid(key) }
        return value
    }
}
