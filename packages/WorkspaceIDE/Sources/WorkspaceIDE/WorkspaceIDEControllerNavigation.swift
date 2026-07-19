import AgentDeskWire
import Foundation
import WorkspaceKit

extension WorkspaceIDEController {
    func bootstrap() async {
        do {
            let loaded = try await dataSource.listWorkspaces()
            guard !Task.isCancelled else { return }
            workspaces = loaded
            let selected = localState.selectedWorkspaceID.flatMap { id in
                loaded.contains(where: { $0.id == id }) ? id : nil
            } ?? loaded.first?.id
            if let selected { selectWorkspace(selected) } else { enqueueProjection() }
        } catch {
            showError("Could not load workspaces.")
            logger.error("workspace list failed: \(String(describing: error), privacy: .public)")
        }
        bootstrapTask = nil
    }

    func selectWorkspace(_ id: String) {
        guard workspaces.contains(where: { $0.id == id }) else {
            showError("That workspace is no longer available.")
            return
        }
        let previous = localState.selectedWorkspaceID
        if previous == id, sharedState != nil { return }
        requestGeneration &+= 1
        let generation = requestGeneration
        unloadWorkspace(workspaceID: previous)
        localState.selectedWorkspaceID = id
        persistLocalState()
        sharedState = nil
        directoryEntries = [:]
        gitResult = nil
        loadingPath = nil
        errorMessage = nil
        delegate?.workspaceIDEController(self, didSelectWorkspace: id)
        enqueueProjection()

        Task { [weak self] in
            guard let self else { return }
            if let previous, previous != id { await dataSource.unsubscribe(workspaceID: previous) }
            do {
                async let state = dataSource.subscribe(workspaceID: id)
                async let root = dataSource.listDirectory(workspaceID: id, path: "")
                async let git = dataSource.gitStatus(workspaceID: id)
                let result = try await (state, root, git)
                guard generation == requestGeneration, localState.selectedWorkspaceID == id else { return }
                acceptSharedState(result.0)
                directoryEntries[""] = result.1
                gitResult = result.2
                await loadExpandedDirectories(generation: generation)
                restoreActivePathIfNeeded(generation: generation)
                enqueueProjection()
            } catch {
                guard generation == requestGeneration else { return }
                showError("Could not open the workspace.")
                logger.error("workspace bootstrap failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func open(path: String) {
        guard validateRelativePath(path) else {
            showError("The selected file path is invalid.")
            return
        }
        localState.activePathByWorkspace[localState.selectedWorkspaceID ?? ""] = path
        persistLocalState()
        applySharedOperation(.open(path: path))
        loadFile(path: path)
    }

    func activate(path: String) {
        guard let workspaceID = localState.selectedWorkspaceID,
              visibleOpenPaths.contains(path) else { return }
        localState.activePathByWorkspace[workspaceID] = path
        persistLocalState()
        if openFiles[path] == nil { loadFile(path: path) }
        enqueueProjection()
    }

    func toggleMode(path: String) {
        guard let workspaceID = localState.selectedWorkspaceID,
              let file = openFiles[path], file.workspaceID == workspaceID,
              !WorkspaceFileKind(path: path).isReadOnly else { return }
        var previewPaths = localState.previewPathsByWorkspace[workspaceID] ?? []
        if previewPaths.contains(path) {
            previewPaths.remove(path)
        } else {
            previewPaths.insert(path)
        }
        localState.previewPathsByWorkspace[workspaceID] = previewPaths
        persistLocalState()
        enqueueProjection()
    }

    func close(path: String) {
        guard let file = openFiles[path] else {
            applySharedOperation(.close(path: path))
            return
        }
        switch file.saveState {
        case .clean:
            applySharedOperation(.close(path: path))
        case .dirty, .autosaving:
            pendingClosePaths.insert(path)
            scheduleAutosave(path: path, immediate: true)
        case .conflict:
            showError("Resolve the file conflict before closing this tab.")
        }
    }

    func applySharedOperation(_ operation: WorkspaceIDEOperation) {
        guard let workspaceID = localState.selectedWorkspaceID,
              let sharedState else { return }
        let generation = requestGeneration
        Task { [weak self] in
            guard let self else { return }
            do {
                let next = try await dataSource.apply(
                    workspaceID: workspaceID,
                    baseRevision: sharedState.revision,
                    operationID: WorkspaceIDEOperationID(value: UUID().uuidString),
                    operation: operation
                )
                guard generation == requestGeneration, localState.selectedWorkspaceID == workspaceID else { return }
                acceptSharedState(next)
                if case .expand(let path) = operation {
                    await loadDirectory(path: path, generation: generation)
                }
                enqueueProjection()
            } catch {
                guard generation == requestGeneration else { return }
                showError("Workspace state changed on another device. Refreshing shared state.")
                do {
                    let latest = try await dataSource.subscribe(workspaceID: workspaceID)
                    guard generation == requestGeneration else { return }
                    acceptSharedState(latest)
                    enqueueProjection()
                } catch {
                    logger.error("workspace state refresh failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    func acceptSharedState(_ state: WorkspaceIDESharedState) {
        guard state.workspaceID == localState.selectedWorkspaceID else { return }
        let remotePaths = Set(state.orderedOpenPaths)
        let locallyOpen = openFiles
        for (path, var file) in locallyOpen where !remotePaths.contains(path) {
            if file.saveState == .clean {
                if let resourceURL = file.resourceURL { documentStore.revoke(resourceURL) }
                openFiles.removeValue(forKey: path)
            } else {
                file.protectedFromRemoteClose = true
                openFiles[path] = file
            }
        }
        sharedState = state
        let active = localState.activePathByWorkspace[state.workspaceID]
        if active == nil || !visibleOpenPaths.contains(active!) {
            localState.activePathByWorkspace[state.workspaceID] = visibleOpenPaths.first
            persistLocalState()
        }
    }

    func receive(_ event: WorkspaceIDEDataEvent) async {
        switch event {
        case .workspaces(let next):
            acceptWorkspaces(next)
        case .sharedState(let state):
            acceptSharedState(state)
            await loadExpandedDirectories(generation: requestGeneration)
            restoreActivePathIfNeeded(generation: requestGeneration)
            enqueueProjection()
        case .gitStatus(let result):
            guard result.workspaceID == localState.selectedWorkspaceID else { return }
            gitResult = result
            enqueueProjection()
        case .workspaceChanged(let change):
            guard change.workspaceID == localState.selectedWorkspaceID else { return }
            await respondToWorkspaceChange(change)
        }
    }

    func acceptWorkspaces(_ next: [WorkspaceSummary]) {
        workspaces = next
        guard let selected = localState.selectedWorkspaceID,
              next.contains(where: { $0.id == selected }) else {
            if let replacement = next.first?.id {
                selectWorkspace(replacement)
            } else {
                requestGeneration &+= 1
                unloadWorkspace(workspaceID: localState.selectedWorkspaceID)
                localState.selectedWorkspaceID = nil
                sharedState = nil
                directoryEntries = [:]
                gitResult = nil
                persistLocalState()
                delegate?.workspaceIDEController(self, didSelectWorkspace: nil)
                enqueueProjection()
            }
            return
        }
        enqueueProjection()
    }

    func unloadWorkspace(workspaceID: String?) {
        if let workspaceID {
            let keys = autosaveTasks.keys.filter { $0.workspaceID == workspaceID }
            for key in keys {
                autosaveTasks.removeValue(forKey: key)?.task.cancel()
            }
        }
        for file in openFiles.values {
            if let resourceURL = file.resourceURL { documentStore.revoke(resourceURL) }
        }
        openFiles.removeAll()
        pendingClosePaths.removeAll()
        loadingPath = nil
        documentStore.removeAll()
    }

    func loadExpandedDirectories(generation: UInt64) async {
        guard let sharedState else { return }
        for path in sharedState.expandedDirectoryPaths where directoryEntries[path] == nil {
            await loadDirectory(path: path, generation: generation)
        }
    }

    func loadDirectory(path: String, generation: UInt64) async {
        guard let workspaceID = localState.selectedWorkspaceID else { return }
        do {
            let entries = try await dataSource.listDirectory(workspaceID: workspaceID, path: path)
            guard generation == requestGeneration else { return }
            directoryEntries[path] = entries
        } catch {
            guard generation == requestGeneration else { return }
            logger.error("directory read failed for \(path, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    func restoreActivePathIfNeeded(generation: UInt64) {
        guard generation == requestGeneration,
              let workspaceID = localState.selectedWorkspaceID,
              let path = localState.activePathByWorkspace[workspaceID],
              visibleOpenPaths.contains(path), openFiles[path] == nil else { return }
        loadFile(path: path)
    }

    var visibleOpenPaths: [String] {
        var paths = sharedState?.orderedOpenPaths ?? []
        for (path, file) in openFiles where file.protectedFromRemoteClose && !paths.contains(path) {
            paths.append(path)
        }
        return paths
    }

    func validateRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/") else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".."
        }
    }
}
