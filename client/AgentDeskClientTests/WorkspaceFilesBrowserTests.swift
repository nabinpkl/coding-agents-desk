import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskClient

/// A scriptable Files requester. A path can be answered immediately (scripted) or gated (held until
/// the test releases it), so both the happy path and the mid-flight supersede are deterministic.
private actor MockFilesRequester: WorkspaceFilesRequesting {
    private var scripted: [String: [WorkspaceDirectoryEntry]] = [:]
    private var scriptedFiles: [String: String] = [:]
    private var gated: Set<String> = []
    private var gates: [String: CheckedContinuation<WorkspaceFileResponse, Error>] = [:]
    private(set) var requestedPaths: [String] = []

    func script(path: String, entries: [WorkspaceDirectoryEntry]) { scripted[path] = entries }
    func scriptFile(path: String, text: String) { scriptedFiles[path] = text }
    func gate(path: String) { gated.insert(path) }

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
        if case .read(let requestID, let workspaceID, let path) = request {
            return .read(
                requestID: requestID,
                result: WorkspaceFileReadResult(
                    workspaceID: workspaceID, path: path,
                    text: scriptedFiles[path] ?? "", revision: WorkspaceFileRevision(digest: "d")
                )
            )
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
        #expect(browser.model.preview == .loaded(path: "README.md", text: "# Demo\n"))

        browser.closePreview()
        #expect(browser.model.preview == nil)
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
