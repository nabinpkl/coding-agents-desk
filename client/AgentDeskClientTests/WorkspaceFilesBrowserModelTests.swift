import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskClient

private func dir(_ name: String, _ path: String) -> WorkspaceDirectoryEntry {
    WorkspaceDirectoryEntry(name: name, path: path, isDirectory: true)
}

private func file(_ name: String, _ path: String) -> WorkspaceDirectoryEntry {
    WorkspaceDirectoryEntry(name: name, path: path, isDirectory: false)
}

struct WorkspaceFilesBrowserModelTests {
    @Test func selectingWorkspaceResetsToRootAndLoads() {
        let model = WorkspaceFilesBrowserModel(path: "src/app", entries: [file("a", "src/app/a")], status: .loaded)
            .selectingWorkspace("w1")
        #expect(model.selectedWorkspaceID == "w1")
        #expect(model.path == "")
        #expect(model.entries.isEmpty)
        #expect(model.status == .loading)
        #expect(model.canNavigateUp == false)
        #expect(model.generation == 1)
    }

    @Test func enteringDirectorySetsPathBumpsGenerationAndLoads() {
        let model = WorkspaceFilesBrowserModel(selectedWorkspaceID: "w1", status: .loaded)
            .enteringDirectory(dir("src", "src"))
        #expect(model.path == "src")
        #expect(model.status == .loading)
        #expect(model.breadcrumb == ["src"])
        #expect(model.generation == 1)
    }

    @Test func enteringFileIsANoOp() {
        let base = WorkspaceFilesBrowserModel(selectedWorkspaceID: "w1", path: "src", status: .loaded)
        #expect(base.enteringDirectory(file("main.swift", "src/main.swift")) == base)
    }

    @Test func navigatingUpPopsOneComponentAndStopsAtRoot() {
        let deep = WorkspaceFilesBrowserModel(selectedWorkspaceID: "w1", path: "src/app/ui", status: .loaded)
        let up1 = deep.navigatingUp()
        #expect(up1.path == "src/app")
        #expect(up1.status == .loading)
        #expect(up1.generation == deep.generation + 1)
        let root = up1.navigatingUp().navigatingUp()
        #expect(root.path == "")
        #expect(root.canNavigateUp == false)
        #expect(root.navigatingUp() == root) // no-op at root, no generation bump
    }

    @Test func directoryLoadedAppliesOnlyToTheCurrentGeneration() {
        let atSrc = WorkspaceFilesBrowserModel(selectedWorkspaceID: "w1", status: .loaded)
            .enteringDirectory(dir("src", "src")) // generation 1
        let entries = [dir("ui", "src/ui"), file("main.swift", "src/main.swift")]

        let applied = atSrc.directoryLoaded(generation: atSrc.generation, entries: entries)
        #expect(applied.entries == entries)
        #expect(applied.status == .loaded)

        // Navigate on, then a listing for the earlier generation arrives late: it is ignored.
        let moved = applied.enteringDirectory(dir("ui", "src/ui")) // generation 2
        let stale = moved.directoryLoaded(generation: atSrc.generation, entries: entries)
        #expect(stale.path == "src/ui")
        #expect(stale.entries.isEmpty)
        #expect(stale.status == .loading)
    }

    @Test func failedAppliesOnlyToTheCurrentGeneration() {
        let atSrc = WorkspaceFilesBrowserModel(selectedWorkspaceID: "w1", status: .loading)
            .enteringDirectory(dir("src", "src")) // generation 1
        let failed = atSrc.failed(generation: atSrc.generation, message: "Access to this path is not permitted.")
        #expect(failed.status == .failed("Access to this path is not permitted."))
    }

    /// The reviewer's scenario: a late failure from an abandoned navigation must not clobber a
    /// newer directory that has already loaded successfully.
    @Test func staleFailureDoesNotClobberANewerLoadedDirectory() {
        let base = WorkspaceFilesBrowserModel(selectedWorkspaceID: "w1", status: .loading)
        let rootGeneration = base.generation
        let loadedApp = base
            .enteringDirectory(dir("app", "app")) // supersedes the root request
            .directoryLoaded(generation: base.generation + 1, entries: [file("x", "app/x")])
        #expect(loadedApp.status == .loaded)

        // The abandoned root request now fails; it must be ignored.
        let afterStaleFailure = loadedApp.failed(generation: rootGeneration, message: "timed out")
        #expect(afterStaleFailure.status == .loaded)
        #expect(afterStaleFailure.entries == [file("x", "app/x")])
    }
}
