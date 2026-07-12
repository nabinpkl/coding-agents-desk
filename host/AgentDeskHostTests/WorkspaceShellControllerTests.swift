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

    @Test func addWorkspaceRegistersAndActivatesIt() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let controller = WorkspaceShellController(repository: repository(in: directory))
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

        let controller = WorkspaceShellController(repository: repository(in: directory))
        try await controller.addWorkspace(root: root, name: "Project")

        let tree = try #require(controller.activeFileTree())
        #expect(tree.rootNode.children().map(\.name) == ["src", "README.md"])
    }

    @Test func activeFileTreeIsNilWithoutAnActiveWorkspace() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let controller = WorkspaceShellController(repository: repository(in: directory))
        #expect(controller.activeFileTree() == nil)
    }

    @Test func loadFailsLoudOnACorruptStore() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let destination = directory.appendingPathComponent("workspaces.json")
        try Data("not json".utf8).write(to: destination)

        let controller = WorkspaceShellController(repository: repository(in: directory))
        await #expect(throws: Error.self) {
            try await controller.load()
        }
    }
}
