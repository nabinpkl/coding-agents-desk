import CryptoKit
import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct WorkspaceFilesResponderTests {
    private func digest(_ data: Data) -> WorkspaceFileRevision {
        WorkspaceFileRevision(digest: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }

    /// The whole point of `WorkspaceFilesResponder`: two writes that read the same base revision
    /// must serialize so exactly one commits and the other is told it conflicts. Without the actor
    /// both would pass the revision guard and one write would be silently lost.
    @Test func concurrentConflictingWritesResolveToOneWriteAndOneConflict() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("wf-responder-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let root = directory.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("note.txt")
        let before = Data("before\n".utf8)
        try before.write(to: file)

        let repository = WorkspaceRepository(
            donorURL: directory.appendingPathComponent("absent-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        )
        let workspaceCoordinator = WorkspaceCoordinator(repository: repository)
        let store = try await workspaceCoordinator.apply(
            .register(id: UUID(), root: root, name: "Workspace")
        )
        let workspaceID = store.workspaces[0].id.uuidString
        let responder = WorkspaceFilesResponder(
            workspaceCoordinator: workspaceCoordinator,
            maxBytes: 1_024
        )
        let expected = digest(before)

        async let first = responder.handle(.write(
            requestID: WorkspaceRequestID(value: "a"),
            workspaceID: workspaceID, path: "note.txt", expectedRevision: expected, text: "alpha\n"
        ))
        async let second = responder.handle(.write(
            requestID: WorkspaceRequestID(value: "b"),
            workspaceID: workspaceID, path: "note.txt", expectedRevision: expected, text: "beta\n"
        ))
        let responses = await [first, second]

        let writes = responses.filter { if case .write = $0 { return true } else { return false } }
        let conflicts = responses.filter { if case .conflict = $0 { return true } else { return false } }
        #expect(writes.count == 1)
        #expect(conflicts.count == 1)

        // The file on disk holds exactly the winner's text, never a torn or lost value.
        let finalText = try String(contentsOf: file, encoding: .utf8)
        #expect(finalText == "alpha\n" || finalText == "beta\n")
    }

    @Test func unknownWorkspaceReturnsErrorWithMatchingRequestID() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("wf-responder-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let repository = WorkspaceRepository(
            donorURL: directory.appendingPathComponent("absent-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        )
        let responder = WorkspaceFilesResponder(
            workspaceCoordinator: WorkspaceCoordinator(repository: repository),
            maxBytes: 1_024
        )
        let requestID = WorkspaceRequestID(value: "list")

        let response = await responder.handle(.listDirectory(
            requestID: requestID, workspaceID: UUID().uuidString, path: ""
        ))

        guard case .error(let responseID, let error) = response else {
            Issue.record("expected an error for an unknown workspace")
            return
        }
        #expect(responseID == requestID)
        #expect(error.code == .notFound)
    }
}
