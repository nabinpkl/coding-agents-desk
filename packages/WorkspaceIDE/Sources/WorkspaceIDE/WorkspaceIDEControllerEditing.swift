import AgentDeskWire
import Foundation
import WorkspaceKit

extension WorkspaceIDEController {
    func loadFile(path: String) {
        guard let workspaceID = localState.selectedWorkspaceID,
              validateRelativePath(path) else { return }
        let generation = requestGeneration
        loadingPath = path
        errorMessage = nil
        enqueueProjection()
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await dataSource.readFile(workspaceID: workspaceID, path: path)
                guard generation == requestGeneration,
                      localState.selectedWorkspaceID == workspaceID else { return }
                var content = result.content
                var saveState = WorkspaceIDEFileSaveState.clean
                if case .text = result.content,
                   let draft = try draftStore.draft(workspaceID: workspaceID, path: path) {
                    content = .text(draft.text)
                    saveState = draft.baselineRevision == result.revision ? .dirty : .conflict
                }
                let resourceURL: URL?
                if case .document(let data) = content {
                    resourceURL = documentStore.publish(documentData: data)
                } else {
                    resourceURL = nil
                }
                if let previousURL = openFiles[path]?.resourceURL {
                    documentStore.revoke(previousURL)
                }
                openFiles[path] = WorkspaceIDEOpenFile(
                    workspaceID: workspaceID,
                    path: path,
                    content: content,
                    revision: result.revision,
                    saveState: saveState,
                    resourceURL: resourceURL,
                    protectedFromRemoteClose: false,
                    renderToken: UUID().uuidString
                )
                loadingPath = loadingPath == path ? nil : loadingPath
                if saveState == .dirty { scheduleAutosave(path: path) }
                enqueueProjection()
            } catch {
                guard generation == requestGeneration else { return }
                loadingPath = loadingPath == path ? nil : loadingPath
                showError("Could not open \((path as NSString).lastPathComponent).")
                logger.error("file read failed for \(path, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    func edit(path: String, text: String) {
        guard let workspaceID = localState.selectedWorkspaceID,
              var file = openFiles[path],
              file.workspaceID == workspaceID,
              case .text = file.content,
              !WorkspaceFileKind(path: path).isReadOnly else { return }
        let remainsConflicted = file.saveState == .conflict
        file.content = .text(text)
        file.saveState = remainsConflicted ? .conflict : .dirty
        openFiles[path] = file
        do {
            try draftStore.save(WorkspaceIDEDraft(
                workspaceID: workspaceID,
                path: path,
                text: text,
                baselineRevision: file.revision
            ))
        } catch {
            showError("Could not preserve the local draft.")
            logger.error("draft write failed: \(String(describing: error), privacy: .public)")
            return
        }
        if !remainsConflicted { scheduleAutosave(path: path) }
        enqueueProjection()
    }

    func scheduleAutosave(path: String, immediate: Bool = false) {
        guard let file = openFiles[path] else { return }
        let key = WorkspaceIDEFileKey(workspaceID: file.workspaceID, path: path)
        if autosaveTasks[key]?.phase == .writing { return }
        autosaveTasks.removeValue(forKey: key)?.task.cancel()
        let taskID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            if !immediate {
                do { try await Task.sleep(for: autosaveDelay) } catch { return }
            }
            guard !Task.isCancelled else { return }
            guard beginAutosaveTask(key: key, taskID: taskID) else { return }
            await autosave(key: key, taskID: taskID)
        }
        autosaveTasks[key] = WorkspaceIDEAutosaveTask(id: taskID, task: task, phase: .debouncing)
    }

    func autosave(key: WorkspaceIDEFileKey, taskID: UUID) async {
        let path = key.path
        guard var file = openFiles[path], file.workspaceID == key.workspaceID,
              case .dirty = file.saveState, case .text(let text) = file.content else {
            removeAutosaveTask(key: key, taskID: taskID)
            return
        }
        file.saveState = .autosaving
        openFiles[path] = file
        enqueueProjection()
        do {
            let outcome = try await dataSource.writeFile(
                workspaceID: file.workspaceID,
                path: path,
                expectedRevision: file.revision,
                text: text
            )
            switch outcome {
            case .saved(let result):
                guard var current = openFiles[path], current.workspaceID == key.workspaceID else {
                    if let draft = try? draftStore.draft(workspaceID: key.workspaceID, path: path),
                       draft.text == text, draft.baselineRevision == file.revision {
                        try? draftStore.remove(workspaceID: key.workspaceID, path: path)
                    }
                    removeAutosaveTask(key: key, taskID: taskID)
                    return
                }
                if case .text(let currentText) = current.content, currentText == text {
                    current.revision = result.revision
                    current.saveState = .clean
                    current.protectedFromRemoteClose = false
                    openFiles[path] = current
                    try? draftStore.remove(workspaceID: file.workspaceID, path: path)
                    removeAutosaveTask(key: key, taskID: taskID)
                    if pendingClosePaths.remove(path) != nil {
                        applySharedOperation(.close(path: path))
                    }
                } else {
                    current.revision = result.revision
                    current.saveState = .dirty
                    openFiles[path] = current
                    removeAutosaveTask(key: key, taskID: taskID)
                    scheduleAutosave(path: path)
                }
            case .conflict:
                guard var current = openFiles[path], current.workspaceID == key.workspaceID else {
                    removeAutosaveTask(key: key, taskID: taskID)
                    return
                }
                current.saveState = .conflict
                current.protectedFromRemoteClose = true
                openFiles[path] = current
                removeAutosaveTask(key: key, taskID: taskID)
            }
        } catch {
            guard var current = openFiles[path], current.workspaceID == key.workspaceID,
                  current.saveState == .autosaving else {
                removeAutosaveTask(key: key, taskID: taskID)
                return
            }
            current.saveState = .dirty
            openFiles[path] = current
            removeAutosaveTask(key: key, taskID: taskID)
            logger.error("autosave failed for \(path, privacy: .public): \(String(describing: error), privacy: .public)")
        }
        enqueueProjection()
    }

    func useHost(path: String) {
        guard let workspaceID = localState.selectedWorkspaceID else { return }
        let key = WorkspaceIDEFileKey(workspaceID: workspaceID, path: path)
        autosaveTasks.removeValue(forKey: key)?.task.cancel()
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await dataSource.readFile(workspaceID: workspaceID, path: path)
                guard localState.selectedWorkspaceID == workspaceID else { return }
                let resourceURL: URL?
                if case .document(let data) = result.content {
                    resourceURL = documentStore.publish(documentData: data)
                } else { resourceURL = nil }
                if let previousURL = openFiles[path]?.resourceURL {
                    documentStore.revoke(previousURL)
                }
                openFiles[path] = WorkspaceIDEOpenFile(
                    workspaceID: workspaceID,
                    path: path,
                    content: result.content,
                    revision: result.revision,
                    saveState: .clean,
                    resourceURL: resourceURL,
                    protectedFromRemoteClose: false,
                    renderToken: UUID().uuidString
                )
                try draftStore.remove(workspaceID: workspaceID, path: path)
                pendingClosePaths.remove(path)
                enqueueProjection()
            } catch {
                showError("Could not reload the host version.")
            }
        }
    }

    func keepMine(path: String) {
        guard let workspaceID = localState.selectedWorkspaceID,
              var file = openFiles[path],
              case .text(let retainedText) = file.content else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let latest = try await dataSource.readFile(workspaceID: workspaceID, path: path)
                guard localState.selectedWorkspaceID == workspaceID else { return }
                file.revision = latest.revision
                file.content = .text(retainedText)
                file.saveState = .dirty
                openFiles[path] = file
                try draftStore.save(WorkspaceIDEDraft(
                    workspaceID: workspaceID,
                    path: path,
                    text: retainedText,
                    baselineRevision: latest.revision
                ))
                scheduleAutosave(path: path, immediate: true)
                enqueueProjection()
            } catch {
                showError("Could not fetch the latest host revision.")
            }
        }
    }

    func removeAutosaveTask(key: WorkspaceIDEFileKey, taskID: UUID) {
        guard autosaveTasks[key]?.id == taskID else { return }
        autosaveTasks.removeValue(forKey: key)
    }

    func beginAutosaveTask(key: WorkspaceIDEFileKey, taskID: UUID) -> Bool {
        guard var entry = autosaveTasks[key], entry.id == taskID else { return false }
        entry.phase = .writing
        autosaveTasks[key] = entry
        return true
    }

    func respondToWorkspaceChange(_ change: WorkspaceChangedPush) async {
        let generation = requestGeneration
        directoryEntries = [:]
        await loadDirectory(path: "", generation: generation)
        await loadExpandedDirectories(generation: generation)
        for path in change.changedPaths where openFiles[path] != nil {
            guard var file = openFiles[path] else { continue }
            switch file.saveState {
            case .clean:
                loadFile(path: path)
            case .dirty, .autosaving, .conflict:
                file.saveState = .conflict
                file.protectedFromRemoteClose = true
                openFiles[path] = file
            }
        }
        enqueueProjection()
    }
}
