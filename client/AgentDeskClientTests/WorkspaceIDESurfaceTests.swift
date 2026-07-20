import AgentDeskWire
import Foundation
import Testing
import UIKit
import WorkspaceIDE

@testable import AgentDeskClient

@MainActor
struct WorkspaceIDESurfaceTests {
    @Test func retainsBothWebViewsAcrossNativePaneCollapseAndStartsTerminalVisible() {
        let controller = WorkspaceIDEController(
            dataSource: EmptyWorkspaceIDEDataSource(),
            capabilities: .iPhone,
            localStateStore: IDETestStateStore(state: WorkspaceIDELocalState(zoomStep: 2)),
            draftStore: IDETestDraftStore()
        )
        let sidebar = controller.sidebarView
        let editor = controller.editorView
        let surface = WorkspaceIDESurface(
            controller: controller,
            terminalCoordinator: nil,
            terminalSessionOpener: nil
        )
        defer { surface.teardown() }

        #expect(surface.sidebarWebViewForTesting === sidebar)
        #expect(surface.editorWebViewForTesting === editor)
        #expect(!surface.terminalContainerForTesting.isHidden)
        #expect(sidebar.pageZoom == 1.2)
        #expect(editor.pageZoom == 1.2)
        #expect(surface.terminalZoomScaleForTesting == 1.2)

        surface.workspaceIDEController(controller, handle: .setZoomScale(1.1))
        #expect(surface.terminalZoomScaleForTesting == 1.1)

        controller.setPaneLayout(
            sidebarVisible: false,
            terminalVisible: false,
            sidebarFraction: 0.3,
            terminalFraction: 0.4
        )
        surface.workspaceIDEController(controller, handle: .setSidebarVisible(false))
        #expect(sidebar.isHidden)
        #expect(surface.terminalContainerForTesting.isHidden)

        controller.setPaneLayout(
            sidebarVisible: true,
            terminalVisible: true,
            sidebarFraction: 0.3,
            terminalFraction: 0.4
        )
        surface.workspaceIDEController(controller, handle: .setTerminalVisible(true))
        #expect(surface.sidebarWebViewForTesting === sidebar)
        #expect(surface.editorWebViewForTesting === editor)
        #expect(!surface.terminalContainerForTesting.isHidden)
    }
}

private actor EmptyWorkspaceIDEDataSource: WorkspaceIDEDataSource {
    func listWorkspaces() async throws -> [WorkspaceSummary] { [] }
    func listDirectory(workspaceID: String, path: String) async throws -> [WorkspaceDirectoryEntry] { [] }
    func readFile(workspaceID: String, path: String) async throws -> WorkspaceFileReadResult {
        throw CancellationError()
    }
    func writeFile(
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) async throws -> WorkspaceIDEWriteOutcome { throw CancellationError() }
    func subscribe(workspaceID: String) async throws -> WorkspaceIDESharedState { throw CancellationError() }
    func unsubscribe(workspaceID: String) async {}
    func apply(
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async throws -> WorkspaceIDESharedState { throw CancellationError() }
    func gitStatus(workspaceID: String) async throws -> WorkspaceGitStatusResult { throw CancellationError() }
    func events() async -> AsyncStream<WorkspaceIDEDataEvent> { AsyncStream { $0.finish() } }
}

private final class IDETestStateStore: WorkspaceIDELocalStateStoring {
    private var state: WorkspaceIDELocalState

    init(state: WorkspaceIDELocalState = WorkspaceIDELocalState()) {
        self.state = state
    }

    func load() -> WorkspaceIDELocalState { state }
    func save(_ state: WorkspaceIDELocalState) { self.state = state }
}

private final class IDETestDraftStore: WorkspaceIDEDraftStore {
    func draft(workspaceID: String, path: String) throws -> WorkspaceIDEDraft? { nil }
    func save(_ draft: WorkspaceIDEDraft) throws {}
    func remove(workspaceID: String, path: String) throws {}
}
