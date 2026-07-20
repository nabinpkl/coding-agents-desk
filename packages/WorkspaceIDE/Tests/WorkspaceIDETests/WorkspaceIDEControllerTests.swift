import AgentDeskWire
import Foundation
import Testing
@testable import WorkspaceIDE

@MainActor
@Test func controllerRetainsTwoDistinctWebViewsAndSharesOneSelectedWorkspace() async {
    let source = WorkspaceIDEFakeDataSource()
    let stateStore = WorkspaceIDEInMemoryStateStore()
    let controller = WorkspaceIDEController(
        dataSource: source,
        capabilities: .iPhone,
        localStateStore: stateStore,
        draftStore: WorkspaceIDEInMemoryDraftStore()
    )
    let sidebar = controller.sidebarView
    let editor = controller.editorView

    controller.start()
    await eventually { controller.localState.selectedWorkspaceID == "workspace-1" }

    #expect(sidebar !== editor)
    #expect(controller.sidebarView === sidebar)
    #expect(controller.editorView === editor)
    #expect(controller.sidebarProjection().selectedWorkspaceID == "workspace-1")
    #expect(controller.editorProjection().workspaceName == "Workspace")
    controller.setPaneLayout(sidebarVisible: false, terminalVisible: false, sidebarFraction: 0.4, terminalFraction: 0.5)
    #expect(controller.sidebarView === sidebar)
    #expect(controller.editorView === editor)
    controller.stop()
}

@MainActor
@Test func emptyEditorProjectionIsNotLoadingAFile() {
    let controller = makeController()
    controller.localState.selectedWorkspaceID = "workspace-1"

    let projection = controller.editorProjection()

    #expect(projection.activePath == nil)
    #expect(projection.file == nil)
    #expect(!projection.loading)
}

@MainActor
@Test func zoomIntentScalesBothWebRegionsAndPersistsOneLocalValue() {
    let stateStore = WorkspaceIDEInMemoryStateStore()
    let delegate = WorkspaceIDEDelegateSpy()
    let controller = WorkspaceIDEController(
        dataSource: WorkspaceIDEFakeDataSource(),
        capabilities: .iPhone,
        localStateStore: stateStore,
        draftStore: WorkspaceIDEInMemoryDraftStore(),
        delegate: delegate
    )

    controller.handle(.zoomIn)

    #expect(controller.currentLocalState.zoomScale == 1.1)
    #expect(controller.sidebarView.pageZoom == 1.1)
    #expect(controller.editorView.pageZoom == 1.1)
    #expect(stateStore.state.zoomScale == 1.1)
    #expect(delegate.intents == [.setZoomScale(1.1)])
}

@MainActor
@Test func remoteCloseProtectsDirtyLocalBuffer() {
    let controller = makeController()
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.sharedState = WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 1,
        orderedOpenPaths: ["README.md"], expandedDirectoryPaths: []
    )
    controller.openFiles["README.md"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "README.md", content: .text("draft"),
        revision: WorkspaceFileRevision(digest: "one"), saveState: .dirty,
        resourceURL: nil, protectedFromRemoteClose: false, renderToken: "one"
    )

    controller.acceptSharedState(WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 2,
        orderedOpenPaths: [], expandedDirectoryPaths: []
    ))

    #expect(controller.visibleOpenPaths == ["README.md"])
    #expect(controller.openFiles["README.md"]?.protectedFromRemoteClose == true)
}

@MainActor
@Test func remoteSharedStateReconciliationPreservesTheLocalActiveTab() {
    let controller = makeController()
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.localState.activePathByWorkspace["workspace-1"] = "README.md"
    controller.sharedState = WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 1,
        orderedOpenPaths: ["README.md", "Notes.md"], expandedDirectoryPaths: []
    )

    controller.acceptSharedState(WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 2,
        orderedOpenPaths: ["Notes.md", "README.md"], expandedDirectoryPaths: ["Sources"]
    ))

    #expect(controller.localState.activePathByWorkspace["workspace-1"] == "README.md")
    #expect(controller.sharedState?.orderedOpenPaths == ["Notes.md", "README.md"])
    #expect(controller.sharedState?.expandedDirectoryPaths == ["Sources"])
}

@MainActor
@Test func autosaveAdvancesRevisionAndDeletesDraft() async throws {
    let source = WorkspaceIDEFakeDataSource()
    let drafts = WorkspaceIDEInMemoryDraftStore()
    let controller = WorkspaceIDEController(
        dataSource: source,
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: drafts,
        autosaveDelay: .zero
    )
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.sharedState = WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 1,
        orderedOpenPaths: ["README.md"], expandedDirectoryPaths: []
    )
    controller.openFiles["README.md"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "README.md", content: .text("old"),
        revision: WorkspaceFileRevision(digest: "one"), saveState: .clean,
        resourceURL: nil, protectedFromRemoteClose: false, renderToken: "one"
    )

    controller.edit(path: "README.md", text: "new")
    await eventually { controller.openFiles["README.md"]?.saveState == .clean }

    #expect(controller.openFiles["README.md"]?.revision == WorkspaceFileRevision(digest: "two"))
    #expect(try drafts.draft(workspaceID: "workspace-1", path: "README.md") == nil)
    #expect(await source.writtenTexts() == ["new"])
}

@MainActor
@Test func editsDuringAnInFlightAutosaveRemainSerializedAndSaveTheLatestText() async {
    let source = WorkspaceIDESerialWriteDataSource()
    let controller = WorkspaceIDEController(
        dataSource: source,
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: WorkspaceIDEInMemoryDraftStore(),
        autosaveDelay: .zero
    )
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.openFiles["README.md"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "README.md", content: .text("old"),
        revision: WorkspaceFileRevision(digest: "zero"), saveState: .clean,
        resourceURL: nil, protectedFromRemoteClose: false, renderToken: "one"
    )

    controller.edit(path: "README.md", text: "first")
    for _ in 0..<100 {
        if await source.activeWriteCount() > 0 { break }
        try? await Task.sleep(for: .milliseconds(1))
    }
    controller.edit(path: "README.md", text: "second")
    for _ in 0..<500 {
        if await source.writtenTexts().count >= 2,
           controller.openFiles["README.md"]?.saveState == .clean { break }
        try? await Task.sleep(for: .milliseconds(1))
    }

    #expect(await source.writtenTexts() == ["first", "second"])
    #expect(await source.maximumConcurrentWrites() == 1)
    #expect(controller.openFiles["README.md"]?.saveState == .clean)
}

@MainActor
@Test func forgedHostOnlyIntentIsRejectedOnIPhone() {
    let delegate = WorkspaceIDEDelegateSpy()
    let controller = WorkspaceIDEController(
        dataSource: WorkspaceIDEFakeDataSource(),
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: WorkspaceIDEInMemoryDraftStore(),
        delegate: delegate
    )

    controller.handle(.addWorkspace)

    #expect(delegate.intents.isEmpty)
    #expect(controller.errorMessage == "That workspace action is not available on this device.")
}

@MainActor
@Test func switchingWorkspacesUnloadsPathCollisionsAndCancelsPreviousAutosave() throws {
    let drafts = WorkspaceIDEInMemoryDraftStore()
    let controller = WorkspaceIDEController(
        dataSource: WorkspaceIDEFakeDataSource(),
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: drafts,
        autosaveDelay: .seconds(60)
    )
    controller.workspaces = [
        WorkspaceSummary(id: "workspace-1", name: "One"),
        WorkspaceSummary(id: "workspace-2", name: "Two"),
    ]
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.sharedState = WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 1,
        orderedOpenPaths: ["README.md"], expandedDirectoryPaths: []
    )
    controller.openFiles["README.md"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "README.md", content: .text("one"),
        revision: WorkspaceFileRevision(digest: "one"), saveState: .clean,
        resourceURL: nil, protectedFromRemoteClose: false, renderToken: "one"
    )

    controller.edit(path: "README.md", text: "draft one")
    #expect(controller.autosaveTasks.keys.contains(WorkspaceIDEFileKey(
        workspaceID: "workspace-1", path: "README.md"
    )))

    controller.selectWorkspace("workspace-2")

    #expect(controller.openFiles.isEmpty)
    #expect(controller.autosaveTasks.isEmpty)
    #expect(try drafts.draft(workspaceID: "workspace-1", path: "README.md")?.text == "draft one")
    controller.stop()
}

@MainActor
@Test func editingAConflictKeepsAutosavePausedUntilExplicitResolution() async throws {
    let source = WorkspaceIDEFakeDataSource()
    let drafts = WorkspaceIDEInMemoryDraftStore()
    let controller = WorkspaceIDEController(
        dataSource: source,
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: drafts,
        autosaveDelay: .zero
    )
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.openFiles["README.md"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "README.md", content: .text("mine"),
        revision: WorkspaceFileRevision(digest: "one"), saveState: .conflict,
        resourceURL: nil, protectedFromRemoteClose: true, renderToken: "one"
    )

    controller.edit(path: "README.md", text: "mine again")
    await Task.yield()

    #expect(controller.openFiles["README.md"]?.saveState == .conflict)
    #expect(controller.autosaveTasks.isEmpty)
    #expect(await source.writtenTexts().isEmpty)
    #expect(try drafts.draft(workspaceID: "workspace-1", path: "README.md")?.text == "mine again")
}

@MainActor
@Test func fileModeIsDeviceLocalAndReadOnlyDocumentsCannotEnterEditMode() {
    let controller = makeController()
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.openFiles["README.md"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "README.md", content: .text("text"),
        revision: WorkspaceFileRevision(digest: "one"), saveState: .clean,
        resourceURL: nil, protectedFromRemoteClose: false, renderToken: "one"
    )
    controller.openFiles["Report.docx"] = WorkspaceIDEOpenFile(
        workspaceID: "workspace-1", path: "Report.docx", content: .document(Data()),
        revision: WorkspaceFileRevision(digest: "docx"), saveState: .clean,
        resourceURL: nil, protectedFromRemoteClose: false, renderToken: "docx"
    )

    controller.toggleMode(path: "README.md")
    controller.toggleMode(path: "Report.docx")

    #expect(controller.localState.previewPathsByWorkspace["workspace-1"] == ["README.md"])
}

@MainActor
@Test func matchingDraftRestoresDirtyContentWithoutReplacingTheHostBaseline() async throws {
    let drafts = WorkspaceIDEInMemoryDraftStore()
    try drafts.save(WorkspaceIDEDraft(
        workspaceID: "workspace-1",
        path: "README.md",
        text: "restored draft",
        baselineRevision: WorkspaceFileRevision(digest: "one")
    ))
    let controller = WorkspaceIDEController(
        dataSource: WorkspaceIDEFakeDataSource(),
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: drafts,
        autosaveDelay: .seconds(60)
    )
    controller.localState.selectedWorkspaceID = "workspace-1"
    controller.sharedState = WorkspaceIDESharedState(
        workspaceID: "workspace-1", revision: 1,
        orderedOpenPaths: ["README.md"], expandedDirectoryPaths: []
    )

    controller.loadFile(path: "README.md")
    await eventually { controller.openFiles["README.md"] != nil }

    #expect(controller.openFiles["README.md"]?.content == .text("restored draft"))
    #expect(controller.openFiles["README.md"]?.saveState == .dirty)
    #expect(controller.openFiles["README.md"]?.revision == WorkspaceFileRevision(digest: "one"))
    controller.stop()
}

@MainActor
private func makeController() -> WorkspaceIDEController {
    WorkspaceIDEController(
        dataSource: WorkspaceIDEFakeDataSource(),
        capabilities: .iPhone,
        localStateStore: WorkspaceIDEInMemoryStateStore(),
        draftStore: WorkspaceIDEInMemoryDraftStore()
    )
}

@MainActor
private func eventually(
    attempts: Int = 100,
    _ predicate: @escaping @MainActor () -> Bool
) async {
    for _ in 0..<attempts {
        if predicate() { return }
        await Task.yield()
    }
    Issue.record("condition did not become true")
}

private actor WorkspaceIDEFakeDataSource: WorkspaceIDEDataSource {
    private var writes: [String] = []

    func listWorkspaces() async throws -> [WorkspaceSummary] {
        [WorkspaceSummary(id: "workspace-1", name: "Workspace")]
    }

    func listDirectory(workspaceID: String, path: String) async throws -> [WorkspaceDirectoryEntry] {
        []
    }

    func readFile(workspaceID: String, path: String) async throws -> WorkspaceFileReadResult {
        WorkspaceFileReadResult(
            workspaceID: workspaceID, path: path, text: "host",
            revision: WorkspaceFileRevision(digest: "one")
        )
    }

    func writeFile(
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) async throws -> WorkspaceIDEWriteOutcome {
        writes.append(text)
        return .saved(WorkspaceFileWriteResult(
            workspaceID: workspaceID, path: path,
            revision: WorkspaceFileRevision(digest: "two")
        ))
    }

    func subscribe(workspaceID: String) async throws -> WorkspaceIDESharedState {
        WorkspaceIDESharedState(
            workspaceID: workspaceID, revision: 0,
            orderedOpenPaths: [], expandedDirectoryPaths: []
        )
    }

    func unsubscribe(workspaceID: String) async {}

    func apply(
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async throws -> WorkspaceIDESharedState {
        WorkspaceIDESharedState(
            workspaceID: workspaceID, revision: baseRevision + 1,
            orderedOpenPaths: [], expandedDirectoryPaths: []
        )
    }

    func gitStatus(workspaceID: String) async throws -> WorkspaceGitStatusResult {
        WorkspaceGitStatusResult(workspaceID: workspaceID, generation: 0, entries: [])
    }

    func events() async -> AsyncStream<WorkspaceIDEDataEvent> { AsyncStream { $0.finish() } }
    func writtenTexts() -> [String] { writes }
}

private actor WorkspaceIDESerialWriteDataSource: WorkspaceIDEDataSource {
    private var writes: [String] = []
    private var activeWrites = 0
    private var maximumActiveWrites = 0

    func listWorkspaces() async throws -> [WorkspaceSummary] { [] }
    func listDirectory(workspaceID: String, path: String) async throws -> [WorkspaceDirectoryEntry] { [] }
    func readFile(workspaceID: String, path: String) async throws -> WorkspaceFileReadResult {
        WorkspaceFileReadResult(
            workspaceID: workspaceID, path: path, text: "host",
            revision: WorkspaceFileRevision(digest: "host")
        )
    }
    func writeFile(
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) async throws -> WorkspaceIDEWriteOutcome {
        activeWrites += 1
        maximumActiveWrites = max(maximumActiveWrites, activeWrites)
        writes.append(text)
        try? await Task.sleep(for: .milliseconds(25))
        activeWrites -= 1
        return .saved(WorkspaceFileWriteResult(
            workspaceID: workspaceID, path: path,
            revision: WorkspaceFileRevision(digest: "revision-\(writes.count)")
        ))
    }
    func subscribe(workspaceID: String) async throws -> WorkspaceIDESharedState {
        WorkspaceIDESharedState(
            workspaceID: workspaceID, revision: 0,
            orderedOpenPaths: [], expandedDirectoryPaths: []
        )
    }
    func unsubscribe(workspaceID: String) async {}
    func apply(
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async throws -> WorkspaceIDESharedState {
        WorkspaceIDESharedState(
            workspaceID: workspaceID, revision: baseRevision,
            orderedOpenPaths: [], expandedDirectoryPaths: []
        )
    }
    func gitStatus(workspaceID: String) async throws -> WorkspaceGitStatusResult {
        WorkspaceGitStatusResult(workspaceID: workspaceID, generation: 0, entries: [])
    }
    func events() async -> AsyncStream<WorkspaceIDEDataEvent> { AsyncStream { $0.finish() } }
    func activeWriteCount() -> Int { activeWrites }
    func maximumConcurrentWrites() -> Int { maximumActiveWrites }
    func writtenTexts() -> [String] { writes }
}

private final class WorkspaceIDEInMemoryStateStore: WorkspaceIDELocalStateStoring {
    var state = WorkspaceIDELocalState()
    func load() -> WorkspaceIDELocalState { state }
    func save(_ state: WorkspaceIDELocalState) { self.state = state }
}

private final class WorkspaceIDEInMemoryDraftStore: WorkspaceIDEDraftStore {
    private var drafts: [String: WorkspaceIDEDraft] = [:]
    func draft(workspaceID: String, path: String) throws -> WorkspaceIDEDraft? { drafts["\(workspaceID):\(path)"] }
    func save(_ draft: WorkspaceIDEDraft) throws { drafts["\(draft.workspaceID):\(draft.path)"] = draft }
    func remove(workspaceID: String, path: String) throws { drafts.removeValue(forKey: "\(workspaceID):\(path)") }
}

@MainActor
private final class WorkspaceIDEDelegateSpy: WorkspaceIDEDelegate {
    var intents: [WorkspaceIDEPlatformIntent] = []
    func workspaceIDEController(_ controller: WorkspaceIDEController, handle intent: WorkspaceIDEPlatformIntent) {
        intents.append(intent)
    }
}
