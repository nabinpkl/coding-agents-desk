import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskClient

/// A scriptable Files requester. A path can be answered immediately (scripted) or gated (held until
/// the test releases it), so both the happy path and the mid-flight supersede are deterministic.
private actor MockFilesRequester: WorkspaceFilesRequesting {
    private var scripted: [String: [WorkspaceDirectoryEntry]] = [:]
    private var scriptedWorkspaces: [WorkspaceSummary] = []
    private var scriptedFiles: [String: String] = [:]
    private var gated: Set<String> = []
    private var gates: [String: CheckedContinuation<WorkspaceFileResponse, Error>] = [:]
    private var writeConflicts = false
    private var gateWrites = false
    private var writeGate: CheckedContinuation<Void, Never>?
    private(set) var requestedPaths: [String] = []
    private(set) var writtenText: [String: String] = [:]
    private(set) var writeCount = 0

    func script(path: String, entries: [WorkspaceDirectoryEntry]) { scripted[path] = entries }
    func scriptWorkspaces(_ workspaces: [WorkspaceSummary]) { scriptedWorkspaces = workspaces }
    func scriptFile(path: String, text: String) { scriptedFiles[path] = text }
    func setWriteConflicts(_ value: Bool) { writeConflicts = value }
    func gate(path: String) { gated.insert(path) }
    func holdWrites() { gateWrites = true }
    func releaseWrite() { let gate = writeGate; writeGate = nil; gate?.resume() }
    func waitUntilWriteRequested() async { while writeCount == 0 { await Task.yield() } }

    func release(path: String, entries: [WorkspaceDirectoryEntry]) {
        gates.removeValue(forKey: path)?.resume(
            returning: .directory(
                requestID: WorkspaceFileRequestID(value: "gated"),
                result: WorkspaceDirectoryListResult(workspaceID: "w1", path: path, entries: entries)
            )
        )
    }

    func waitUntilRequested(path: String) async {
        while !requestedPaths.contains(path) { await Task.yield() }
    }

    func request(_ request: WorkspaceFileRequest) async throws -> WorkspaceFileResponse {
        if case .listWorkspaces(let requestID) = request {
            return .workspaces(
                requestID: requestID,
                result: WorkspaceListResult(workspaces: scriptedWorkspaces)
            )
        }
        if case .read(let requestID, let workspaceID, let path) = request {
            return .read(
                requestID: requestID,
                result: WorkspaceFileReadResult(
                    workspaceID: workspaceID, path: path,
                    text: scriptedFiles[path] ?? "", revision: WorkspaceFileRevision(digest: "d")
                )
            )
        }
        if case .write(let requestID, let workspaceID, let path, _, let text) = request {
            writeCount += 1
            if gateWrites {
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    writeGate = continuation
                }
            }
            if writeConflicts {
                return .conflict(requestID: requestID, conflict: WorkspaceFileConflict(
                    workspaceID: workspaceID, path: path, currentRevision: WorkspaceFileRevision(digest: "host-newer")
                ))
            }
            writtenText[path] = text
            scriptedFiles[path] = text
            return .write(requestID: requestID, result: WorkspaceFileWriteResult(
                workspaceID: workspaceID, path: path, revision: WorkspaceFileRevision(digest: "d-written")
            ))
        }
        guard case .listDirectory(let requestID, let workspaceID, let path) = request else {
            return .error(requestID: request.requestID, error: WorkspaceFileError(code: .notFound))
        }
        requestedPaths.append(path)
        if gated.contains(path) {
            return try await withCheckedThrowingContinuation { gates[path] = $0 }
        }
        return .directory(
            requestID: requestID,
            result: WorkspaceDirectoryListResult(workspaceID: workspaceID, path: path, entries: scripted[path] ?? [])
        )
    }
}

private func dir(_ name: String, _ path: String) -> WorkspaceDirectoryEntry {
    WorkspaceDirectoryEntry(name: name, path: path, isDirectory: true)
}

private func file(_ name: String, _ path: String) -> WorkspaceDirectoryEntry {
    WorkspaceDirectoryEntry(name: name, path: path, isDirectory: false)
}

@MainActor
struct WorkspaceFilesBrowserTests {
    @Test func selectingWorkspaceListsTheRootAndLoads() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [dir("src", "src"), file("README.md", "README.md")])
        let browser = WorkspaceFilesBrowser(transport: mock)

        await browser.selectWorkspace("w1")

        #expect(browser.model.selectedWorkspaceID == "w1")
        #expect(browser.model.path == "")
        #expect(browser.model.status == .loaded)
        #expect(browser.model.entries.map(\.name) == ["src", "README.md"])
        #expect(await mock.requestedPaths == [""])
    }

    @Test func enteringAndAscendingIssueTheMatchingListings() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [dir("src", "src")])
        await mock.script(path: "src", entries: [file("main.swift", "src/main.swift")])
        let browser = WorkspaceFilesBrowser(transport: mock)

        await browser.selectWorkspace("w1")
        await browser.enter(dir("src", "src"))
        #expect(browser.model.path == "src")
        #expect(browser.model.entries.map(\.name) == ["main.swift"])

        await browser.navigateUp()
        #expect(browser.model.path == "")
        #expect(await mock.requestedPaths == ["", "src", ""])
    }

    @Test func openingAFileLoadsAReadOnlyPreviewAndCloseDismissesIt() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [file("README.md", "README.md")])
        await mock.scriptFile(path: "README.md", text: "# Demo\n")
        let browser = WorkspaceFilesBrowser(transport: mock)

        await browser.selectWorkspace("w1")
        await browser.openFile(file("README.md", "README.md"))
        #expect(browser.model.preview == .loaded(
            path: "README.md", text: "# Demo\n", revision: WorkspaceFileRevision(digest: "d")
        ))

        browser.closePreview()
        #expect(browser.model.preview == nil)
    }

    @Test func savingAFileWritesTheEditedTextAndAdvancesBaseline() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [file("note.txt", "note.txt")])
        await mock.scriptFile(path: "note.txt", text: "old")
        let browser = WorkspaceFilesBrowser(transport: mock)
        await browser.selectWorkspace("w1")
        await browser.openFile(file("note.txt", "note.txt"))

        await browser.saveFile("edited")

        #expect(await mock.writtenText["note.txt"] == "edited")
        #expect(browser.model.saveStatus == .idle)
        #expect(browser.model.preview == .loaded(
            path: "note.txt", text: "edited", revision: WorkspaceFileRevision(digest: "d-written")
        ))
    }

    @Test func aSecondSaveWhileSavingIsIgnored() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [file("note.txt", "note.txt")])
        await mock.scriptFile(path: "note.txt", text: "old")
        await mock.holdWrites()
        let browser = WorkspaceFilesBrowser(transport: mock)
        await browser.selectWorkspace("w1")
        await browser.openFile(file("note.txt", "note.txt"))

        let first = Task { await browser.saveFile("A") }
        await mock.waitUntilWriteRequested()   // first write in flight; model is .saving
        await browser.saveFile("B")            // must be ignored while a save is in flight

        await mock.releaseWrite()
        await first.value
        #expect(await mock.writeCount == 1)
        #expect(browser.model.saveStatus == .idle)
    }

    @Test func aStaleWriteReportsConflictWithoutOverwriting() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [file("note.txt", "note.txt")])
        await mock.scriptFile(path: "note.txt", text: "old")
        await mock.setWriteConflicts(true)
        let browser = WorkspaceFilesBrowser(transport: mock)
        await browser.selectWorkspace("w1")
        await browser.openFile(file("note.txt", "note.txt"))

        await browser.saveFile("edited")

        #expect(browser.model.saveStatus == .conflict)
        // The baseline preview is untouched; the host copy was not overwritten.
        #expect(await mock.writtenText["note.txt"] == nil)
    }

    @Test func openingADirectoryDoesNotOpenAPreview() async {
        let mock = MockFilesRequester()
        await mock.script(path: "", entries: [dir("src", "src")])
        let browser = WorkspaceFilesBrowser(transport: mock)
        await browser.selectWorkspace("w1")
        await browser.openFile(dir("src", "src"))
        #expect(browser.model.preview == nil)
    }

    @Test func aTransportFailureSurfacesAsFailed() async {
        let browser = WorkspaceFilesBrowser(transport: FailingRequester())
        await browser.selectWorkspace("w1")
        guard case .failed = browser.model.status else {
            Issue.record("expected failed status, got \(browser.model.status)")
            return
        }
    }

    @Test func loadWorkspacesAppliesTheList() async {
        let stub = StubRequester(response: .workspaces(
            requestID: WorkspaceFileRequestID(value: "x"),
            result: WorkspaceListResult(workspaces: [WorkspaceSummary(id: "w1", name: "Alpha")])
        ))
        let browser = WorkspaceFilesBrowser(transport: stub)
        await browser.loadWorkspaces()
        #expect(browser.model.workspaces.map(\.name) == ["Alpha"])
    }

    /// The picker contract (R38): loading the workspace list must NOT auto-select or list any
    /// directory. The surface opens on the picker; only an explicit selection issues a listing. This
    /// guards the removal of the old auto-select-first, which hid every workspace but the first.
    @Test func loadWorkspacesDoesNotSelectOrListUntilAWorkspaceIsPicked() async {
        let mock = MockFilesRequester()
        await mock.scriptWorkspaces([
            WorkspaceSummary(id: "w1", name: "Alpha"),
            WorkspaceSummary(id: "w2", name: "Beta"),
        ])
        await mock.script(path: "", entries: [file("b.txt", "b.txt")])
        let browser = WorkspaceFilesBrowser(transport: mock)

        await browser.loadWorkspaces()
        #expect(browser.model.workspaces.map(\.name) == ["Alpha", "Beta"])
        #expect(browser.model.selectedWorkspaceID == nil)
        #expect(await mock.requestedPaths == [])   // nothing listed until the user picks

        await browser.selectWorkspace("w2")
        #expect(browser.model.selectedWorkspaceID == "w2")
        #expect(await mock.requestedPaths == [""])  // exactly the picked workspace's root
    }

    @Test func loadWorkspacesErrorSurfacesAsFailedInsteadOfBeingSwallowed() async {
        let stub = StubRequester(response: .error(
            requestID: WorkspaceFileRequestID(value: "x"),
            error: WorkspaceFileError(code: .notFound, message: "Workspace store is unavailable.")
        ))
        let browser = WorkspaceFilesBrowser(transport: stub)
        await browser.loadWorkspaces()
        guard case .failed(let message) = browser.model.status else {
            Issue.record("expected failed status, got \(browser.model.status)")
            return
        }
        #expect(message == "Workspace store is unavailable.")
    }

    /// A navigation that happens while a listing is in flight supersedes it: the late response is
    /// dropped, and the newer directory stays shown.
    @Test func aSupersededListingIsDropped() async {
        let mock = MockFilesRequester()
        await mock.gate(path: "")                                   // hold the root listing
        await mock.script(path: "src", entries: [file("main.swift", "src/main.swift")])
        let browser = WorkspaceFilesBrowser(transport: mock)

        let selecting = Task { await browser.selectWorkspace("w1") } // requests "", gated
        await mock.waitUntilRequested(path: "")

        await browser.enter(dir("src", "src"))                      // supersedes: requests "src", loads
        #expect(browser.model.path == "src")
        #expect(browser.model.entries.map(\.name) == ["main.swift"])

        // Release the stale root listing; it must not overwrite the loaded "src" view.
        await mock.release(path: "", entries: [dir("other", "other")])
        await selecting.value
        #expect(browser.model.path == "src")
        #expect(browser.model.entries.map(\.name) == ["main.swift"])
    }
}

/// Always fails the request, to drive the browser's failure path.
private struct FailingRequester: WorkspaceFilesRequesting {
    func request(_ request: WorkspaceFileRequest) async throws -> WorkspaceFileResponse {
        throw WorkspaceFilesTransportError.closed
    }
}

/// Returns a fixed response for any request, to drive the workspace-list success and error paths.
private struct StubRequester: WorkspaceFilesRequesting {
    let response: WorkspaceFileResponse
    func request(_ request: WorkspaceFileRequest) async throws -> WorkspaceFileResponse { response }
}
