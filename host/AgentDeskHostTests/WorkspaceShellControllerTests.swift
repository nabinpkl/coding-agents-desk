import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
struct WorkspaceShellControllerTests {
    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("shell-controller-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func repository(in directory: URL) -> WorkspaceRepository {
        WorkspaceRepository(
            donorURL: directory.appendingPathComponent("absent-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        )
    }

    private func makeController(in directory: URL) -> WorkspaceShellController {
        let repository = repository(in: directory)
        return WorkspaceShellController(
            repository: repository,
            filesResponder: WorkspaceFilesResponder(repository: repository, maxBytes: 1_024)
        )
    }

    @Test func addWorkspaceRegistersAndActivatesIt() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let controller = makeController(in: directory)
        try await controller.addWorkspace(root: root, name: "Project")

        #expect(controller.store.workspaces.map(\.name) == ["Project"])
        #expect(controller.store.active?.name == "Project")
    }

    @Test func activeFileTreeListsTheWorkspaceRootDirectoriesFirst() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
        try Data("hi".utf8).write(to: root.appendingPathComponent("README.md"))

        let controller = makeController(in: directory)
        try await controller.addWorkspace(root: root, name: "Project")

        let tree = try #require(controller.activeFileTree())
        #expect(tree.rootNode.children().map(\.name) == ["src", "README.md"])
    }

    @Test func writeFileThroughSharedResponderPersistsRevisionChecked() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("note.txt")
        try Data("before\n".utf8).write(to: file)

        let controller = makeController(in: directory)
        try await controller.addWorkspace(root: root, name: "Project")
        let workspaceID = try #require(controller.store.active?.id.uuidString)

        let read = await controller.readFile(workspaceID: workspaceID, path: "note.txt")
        guard case .read(_, let readResult) = read else {
            Issue.record("expected a read result, got \(read)")
            return
        }
        let write = await controller.writeFile(
            workspaceID: workspaceID, path: "note.txt", expectedRevision: readResult.revision, text: "after\n"
        )
        guard case .write = write else {
            Issue.record("expected a write result, got \(write)")
            return
        }
        #expect(try String(contentsOf: file, encoding: .utf8) == "after\n")

        // A second write with the now-stale revision must conflict, not overwrite.
        let stale = await controller.writeFile(
            workspaceID: workspaceID, path: "note.txt", expectedRevision: readResult.revision, text: "clobber\n"
        )
        guard case .conflict = stale else {
            Issue.record("expected a conflict for the stale revision, got \(stale)")
            return
        }
        #expect(try String(contentsOf: file, encoding: .utf8) == "after\n")
    }

    @Test func loadAutoSelectsTheFirstWorkspaceWhenNoneIsActive() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        // A persisted store with a workspace but no active selection (activeID absent), the shape the
        // donor importer writes and the shape older stores decode to.
        let id = UUID()
        let destination = directory.appendingPathComponent("workspaces.json")
        let json = """
        {"workspaces":[{"id":"\(id.uuidString)","root":"\(root.absoluteString)","name":"project"}]}
        """
        try Data(json.utf8).write(to: destination)

        let repository = WorkspaceRepository(
            donorURL: directory.appendingPathComponent("absent-donor.json"),
            destinationURL: destination
        )
        let controller = WorkspaceShellController(
            repository: repository,
            filesResponder: WorkspaceFilesResponder(repository: repository, maxBytes: 1_024)
        )
        try await controller.load()

        // The shell selects the first workspace so its file tree renders instead of an empty pane.
        #expect(controller.store.active?.id == id)
        #expect(controller.activeFileTree() != nil)
    }

    @Test func activeFileTreeIsNilWithoutAnActiveWorkspace() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let controller = makeController(in: directory)
        #expect(controller.activeFileTree() == nil)
    }

    @Test func loadFailsLoudOnACorruptStore() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let destination = directory.appendingPathComponent("workspaces.json")
        try Data("not json".utf8).write(to: destination)

        let controller = makeController(in: directory)
        await #expect(throws: Error.self) {
            try await controller.load()
        }
    }
}
