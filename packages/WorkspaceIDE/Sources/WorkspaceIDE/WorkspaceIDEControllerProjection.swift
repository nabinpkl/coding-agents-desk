import Foundation
import WorkspaceKit

extension WorkspaceIDEController {
    func sidebarProjection() -> WorkspaceIDESidebarProjection {
        WorkspaceIDESidebarProjection(
            workspaces: workspaces,
            selectedWorkspaceID: localState.selectedWorkspaceID,
            section: localState.sidebarSection,
            tree: treeNodes(in: ""),
            gitEntries: gitResult?.entries ?? [],
            capabilities: capabilities.projectionNames,
            error: errorMessage
        )
    }

    func editorProjection() -> WorkspaceIDEEditorProjection {
        let workspaceID = localState.selectedWorkspaceID
        let activePath = workspaceID.flatMap { localState.activePathByWorkspace[$0] }
        let tabs = visibleOpenPaths.map { path -> WorkspaceIDEEditorTabProjection in
            let file = openFiles[path].flatMap { $0.workspaceID == workspaceID ? $0 : nil }
            return WorkspaceIDEEditorTabProjection(
                path: path,
                name: (path as NSString).lastPathComponent,
                dirty: file?.saveState == .dirty,
                autosaving: file?.saveState == .autosaving,
                conflict: file?.saveState == .conflict,
                protectedFromRemoteClose: file?.protectedFromRemoteClose ?? false
            )
        }
        return WorkspaceIDEEditorProjection(
            workspaceName: workspaces.first(where: { $0.id == workspaceID })?.name,
            tabs: tabs,
            activePath: activePath,
            breadcrumb: activePath?.split(separator: "/").map(String.init) ?? [],
            file: activePath.flatMap(fileProjection(path:)),
            loading: loadingPath == activePath,
            error: errorMessage,
            sidebarVisible: localState.sidebarVisible,
            terminalVisible: localState.terminalVisible
        )
    }

    private func fileProjection(path: String) -> WorkspaceIDEFileProjection? {
        guard let workspaceID = localState.selectedWorkspaceID,
              let file = openFiles[path], file.workspaceID == workspaceID else { return nil }
        let kind = WorkspaceFileKind(path: path)
        let preview = localState.previewPathsByWorkspace[workspaceID]?.contains(path) == true
        let text: String?
        if case .text(let value) = file.content { text = value } else { text = nil }
        return WorkspaceIDEFileProjection(
            id: "\(workspaceID):\(path)",
            name: (path as NSString).lastPathComponent,
            path: path,
            workspace: workspaceID,
            root: "",
            kind: kind.rawValue,
            mode: kind.isReadOnly || preview ? "preview" : "edit",
            text: text,
            resourceURL: file.resourceURL?.absoluteString,
            renderToken: file.renderToken
        )
    }

    private func treeNodes(in directory: String) -> [WorkspaceIDETreeNodeProjection] {
        let expanded = Set(sharedState?.expandedDirectoryPaths ?? [])
        return (directoryEntries[directory] ?? []).map { entry in
            WorkspaceIDETreeNodeProjection(
                name: entry.name,
                path: entry.path,
                isDirectory: entry.isDirectory,
                expanded: entry.isDirectory && expanded.contains(entry.path),
                gitStatus: gitStatus(for: entry.path),
                children: entry.isDirectory && expanded.contains(entry.path) ? treeNodes(in: entry.path) : []
            )
        }
    }

    private func gitStatus(for path: String) -> String? {
        guard let entry = gitResult?.entries.first(where: {
            $0.relativePath == path || $0.relativePath.hasPrefix(path + "/")
        }) else { return nil }
        return [entry.indexStatus, entry.workTreeStatus].compactMap { $0 }.joined()
    }
}
