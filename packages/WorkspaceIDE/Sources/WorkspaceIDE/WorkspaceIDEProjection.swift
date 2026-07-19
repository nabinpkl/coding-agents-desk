import AgentDeskWire
import Foundation

struct WorkspaceIDETreeNodeProjection: Encodable, Equatable {
    let name: String
    let path: String
    let isDirectory: Bool
    let expanded: Bool
    let gitStatus: String?
    let children: [WorkspaceIDETreeNodeProjection]
}

struct WorkspaceIDESidebarProjection: Encodable, Equatable {
    let region = "sidebar"
    let workspaces: [WorkspaceSummary]
    let selectedWorkspaceID: String?
    let section: WorkspaceIDESidebarSection
    let tree: [WorkspaceIDETreeNodeProjection]
    let gitEntries: [WorkspaceGitStatusEntry]
    let capabilities: [String]
    let error: String?
}

struct WorkspaceIDEEditorTabProjection: Encodable, Equatable {
    let path: String
    let name: String
    let dirty: Bool
    let autosaving: Bool
    let conflict: Bool
    let protectedFromRemoteClose: Bool
}

struct WorkspaceIDEFileProjection: Encodable, Equatable {
    let id: String
    let name: String
    let path: String
    let workspace: String
    let root: String
    let kind: String
    let mode: String
    let text: String?
    let resourceURL: String?
    let renderToken: String
}

struct WorkspaceIDEEditorProjection: Encodable, Equatable {
    let region = "editor"
    let workspaceName: String?
    let tabs: [WorkspaceIDEEditorTabProjection]
    let activePath: String?
    let breadcrumb: [String]
    let file: WorkspaceIDEFileProjection?
    let loading: Bool
    let error: String?
    let sidebarVisible: Bool
    let terminalVisible: Bool
}

enum WorkspaceIDEFileSaveState: Equatable {
    case clean
    case dirty
    case autosaving
    case conflict
}

struct WorkspaceIDEOpenFile {
    let workspaceID: String
    let path: String
    var content: WorkspaceFileReadContent
    var revision: WorkspaceFileRevision
    var saveState: WorkspaceIDEFileSaveState
    var resourceURL: URL?
    var protectedFromRemoteClose: Bool
    let renderToken: String
}

struct WorkspaceIDEFileKey: Hashable {
    let workspaceID: String
    let path: String
}

struct WorkspaceIDEAutosaveTask {
    let id: UUID
    let task: Task<Void, Never>
    var phase: WorkspaceIDEAutosavePhase
}

enum WorkspaceIDEAutosavePhase {
    case debouncing
    case writing
}

extension WorkspaceIDEPlatformCapabilities {
    var projectionNames: [String] {
        var names: [String] = []
        if contains(.addWorkspace) { names.append("addWorkspace") }
        if contains(.removeWorkspace) { names.append("removeWorkspace") }
        if contains(.reorderWorkspaces) { names.append("reorderWorkspaces") }
        if contains(.assignDesktop) { names.append("assignDesktop") }
        if contains(.autoAssignDesktop) { names.append("autoAssignDesktop") }
        return names
    }
}
