import CryptoKit
import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

private enum WorkspaceFileServiceTestError: Error {
    case forcedWriteFailure
}

struct WorkspaceFileServiceTests {
    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-files-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// A workspace id derived deterministically from the root path, so separate helper calls for
    /// the same root (one to read the id, one to build the service) agree. Distinct roots stay
    /// distinct, so multi-workspace tests never collide on identity.
    private func workspaceID(for root: URL) -> UUID {
        let bytes = Array(SHA256.hash(data: Data(root.standardizedFileURL.path.utf8)).prefix(16))
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    private func workspace(root: URL, id: UUID? = nil, name: String = "Workspace") throws -> Workspace {
        try Workspace.registering(id: id ?? workspaceID(for: root), root: root, name: name)
    }

    private func store(root: URL, id: UUID? = nil, name: String = "Workspace") throws -> WorkspaceStore {
        try WorkspaceStore().adding(workspace(root: root, id: id, name: name))
    }

    private func service(root: URL, maxTextBytes: Int = 1_024) throws -> WorkspaceFileService {
        WorkspaceFileService(store: try store(root: root), maxUTF8Bytes: maxTextBytes)
    }

    private func requestID(_ value: String = "request") -> WorkspaceFileRequestID {
        WorkspaceFileRequestID(value: value)
    }

    private func error(_ response: WorkspaceFileResponse) -> WorkspaceFileError? {
        guard case .error(_, let error) = response else { return nil }
        return error
    }

    private func digest(_ data: Data) -> WorkspaceFileRevision {
        WorkspaceFileRevision(digest: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }

    @Test func workspaceListPreservesStoreOrder() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let alphaRoot = root.appendingPathComponent("alpha", isDirectory: true)
        let betaRoot = root.appendingPathComponent("beta", isDirectory: true)
        try FileManager.default.createDirectory(at: alphaRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: betaRoot, withIntermediateDirectories: true)
        let alpha = try workspace(root: alphaRoot, name: "Alpha")
        let beta = try workspace(root: betaRoot, name: "Beta")
        let service = WorkspaceFileService(store: try WorkspaceStore().adding(beta).adding(alpha), maxUTF8Bytes: 1_024)

        let response = service.handle(.listWorkspaces(requestID: requestID()))

        guard case .workspaces(let responseID, let result) = response else {
            Issue.record("expected workspace list")
            return
        }
        #expect(responseID == requestID())
        #expect(result.workspaces.map(\.id) == [beta.id.uuidString, alpha.id.uuidString])
        #expect(result.workspaces.map(\.name) == ["Beta", "Alpha"])
    }

    @Test func unknownWorkspaceReturnsNotFound() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let response = try service(root: root).handle(.listDirectory(
            requestID: requestID(), workspaceID: UUID().uuidString, path: ""
        ))

        #expect(error(response)?.code == .notFound)
        #expect(error(response)?.message == "Workspace is unavailable.")
    }

    @Test func rejectsAbsoluteDotDotDotAndEmptyPathComponents() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspaceID = try store(root: root).workspaces[0].id.uuidString
        let service = try service(root: root)

        for path in ["/private/tmp", "folder//file", "./file", "../file", "folder/./file", "folder/../file"] {
            let response = service.handle(.listDirectory(
                requestID: requestID(path), workspaceID: workspaceID, path: path
            ))
            #expect(error(response)?.code == .invalidPath, "path \(path) must be rejected")
        }
    }

    @Test func rootDirectoryListAllowsEmptyRelativePath() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspaceID = try store(root: root).workspaces[0].id.uuidString

        let response = try service(root: root).handle(.listDirectory(
            requestID: requestID(), workspaceID: workspaceID, path: ""
        ))

        guard case .directory(_, let result) = response else {
            Issue.record("expected root directory listing")
            return
        }
        #expect(result.path == "")
    }

    @Test func rejectsIntermediateAndLeafSymlinkEscapesAndOmitsThemFromLists() throws {
        let root = try temporaryDirectory()
        let outside = try temporaryDirectory()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secret.txt"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape-dir"), withDestinationURL: outside)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("escape-file"),
            withDestinationURL: outside.appendingPathComponent("secret.txt")
        )
        let workspaceID = try store(root: root).workspaces[0].id.uuidString
        let service = try service(root: root)

        let intermediate = service.handle(.read(
            requestID: requestID("intermediate"), workspaceID: workspaceID, path: "escape-dir/secret.txt"
        ))
        let leaf = service.handle(.read(
            requestID: requestID("leaf"), workspaceID: workspaceID, path: "escape-file"
        ))
        let listing = service.handle(.listDirectory(
            requestID: requestID("list"), workspaceID: workspaceID, path: ""
        ))

        #expect(error(intermediate)?.code == .forbidden)
        #expect(error(leaf)?.code == .forbidden)
        guard case .directory(_, let result) = listing else {
            Issue.record("expected directory listing")
            return
        }
        #expect(!result.entries.contains { $0.name == "escape-dir" || $0.name == "escape-file" })
    }

    @Test func directoryListIsDirectoriesFirstAndDeterministic() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        for directory in ["zeta", "Alpha"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(directory), withIntermediateDirectories: true)
        }
        for file in ["bravo.txt", "aardvark.txt"] {
            try Data().write(to: root.appendingPathComponent(file))
        }
        let workspaceID = try store(root: root).workspaces[0].id.uuidString

        let response = try service(root: root).handle(.listDirectory(
            requestID: requestID(), workspaceID: workspaceID, path: ""
        ))

        guard case .directory(_, let result) = response else {
            Issue.record("expected directory listing")
            return
        }
        #expect(result.entries.map(\.name) == ["Alpha", "zeta", "aardvark.txt", "bravo.txt"])
        #expect(result.entries.map(\.isDirectory) == [true, true, false, false])
    }

    @Test func rejectsOversizedBinaryAndInvalidUTF8Reads() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("oversized".utf8).write(to: root.appendingPathComponent("large.txt"))
        try Data([0x61, 0x00, 0x62]).write(to: root.appendingPathComponent("binary.dat"))
        try Data([0xff, 0xfe]).write(to: root.appendingPathComponent("invalid.txt"))
        let workspaceID = try store(root: root).workspaces[0].id.uuidString
        let service = try service(root: root, maxTextBytes: 4)

        let oversized = service.handle(.read(
            requestID: requestID("large"), workspaceID: workspaceID, path: "large.txt"
        ))
        let binary = service.handle(.read(
            requestID: requestID("binary"), workspaceID: workspaceID, path: "binary.dat"
        ))
        let invalid = service.handle(.read(
            requestID: requestID("invalid"), workspaceID: workspaceID, path: "invalid.txt"
        ))

        #expect(error(oversized)?.code == .tooLarge)
        #expect(error(binary)?.code == .binary)
        #expect(error(invalid)?.code == .invalidUTF8)
    }

    @Test func readReturnsSHA256OfExactBytes() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("hello\n".utf8)
        try bytes.write(to: root.appendingPathComponent("note.txt"))
        let workspaceID = try store(root: root).workspaces[0].id.uuidString

        let response = try service(root: root).handle(.read(
            requestID: requestID(), workspaceID: workspaceID, path: "note.txt"
        ))

        guard case .read(_, let result) = response else {
            Issue.record("expected text read")
            return
        }
        #expect(result.text == "hello\n")
        #expect(result.revision == digest(bytes))
    }

    @Test func successfulWriteReturnsNewDigestAndAtomicallyReplacesText() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("note.txt")
        let before = Data("before\n".utf8)
        try before.write(to: url)
        let workspaceID = try store(root: root).workspaces[0].id.uuidString
        let service = try service(root: root)

        let response = service.handle(.write(
            requestID: requestID(),
            workspaceID: workspaceID,
            path: "note.txt",
            expectedRevision: digest(before),
            text: "after\n"
        ))

        guard case .write(_, let result) = response else {
            Issue.record("expected write result")
            return
        }
        #expect(try Data(contentsOf: url) == Data("after\n".utf8))
        #expect(result.revision == digest(Data("after\n".utf8)))
    }

    @Test func staleWriteReturnsConflictAndLeavesOriginalBytesUntouched() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("note.txt")
        let before = Data("before\n".utf8)
        let current = Data("current\n".utf8)
        try before.write(to: url)
        let workspaceID = try store(root: root).workspaces[0].id.uuidString
        let service = try service(root: root)
        try current.write(to: url)

        let response = service.handle(.write(
            requestID: requestID(),
            workspaceID: workspaceID,
            path: "note.txt",
            expectedRevision: digest(before),
            text: "replacement\n"
        ))

        guard case .conflict(_, let conflict) = response else {
            Issue.record("expected revision conflict")
            return
        }
        #expect(conflict.currentRevision == digest(current))
        #expect(try Data(contentsOf: url) == current)
    }

    @Test func failedTemporaryWriteCleansItsSiblingTempFile() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("note.txt")
        let before = Data("before\n".utf8)
        try before.write(to: url)
        let snapshot = try store(root: root)
        let service = WorkspaceFileService(
            store: snapshot,
            maxUTF8Bytes: 1_024,
            temporaryFileWriter: { _, _ in throw WorkspaceFileServiceTestError.forcedWriteFailure }
        )

        let response = service.handle(.write(
            requestID: requestID(),
            workspaceID: snapshot.workspaces[0].id.uuidString,
            path: "note.txt",
            expectedRevision: digest(before),
            text: "after\n"
        ))

        #expect(error(response)?.code == .writeFailed)
        #expect(try Data(contentsOf: url) == before)
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
        #expect(!names.contains { $0.hasPrefix(".agentdesk-files-") })
    }
}
