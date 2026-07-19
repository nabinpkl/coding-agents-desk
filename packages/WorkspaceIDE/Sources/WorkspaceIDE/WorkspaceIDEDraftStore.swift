import AgentDeskWire
import CryptoKit
import Foundation

public struct WorkspaceIDEDraft: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let path: String
    public let text: String
    public let baselineRevision: WorkspaceFileRevision
    public let updatedAt: Date

    public init(
        workspaceID: String,
        path: String,
        text: String,
        baselineRevision: WorkspaceFileRevision,
        updatedAt: Date = Date()
    ) {
        self.workspaceID = workspaceID
        self.path = path
        self.text = text
        self.baselineRevision = baselineRevision
        self.updatedAt = updatedAt
    }
}

public protocol WorkspaceIDEDraftStore: AnyObject {
    func draft(workspaceID: String, path: String) throws -> WorkspaceIDEDraft?
    func save(_ draft: WorkspaceIDEDraft) throws
    func remove(workspaceID: String, path: String) throws
}

public final class WorkspaceIDEFileDraftStore: WorkspaceIDEDraftStore {
    private let directory: URL
    private let fileManager: FileManager
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.fileManager = fileManager
        encoder.outputFormatting = [.sortedKeys]
    }

    public func draft(workspaceID: String, path: String) throws -> WorkspaceIDEDraft? {
        let url = fileURL(workspaceID: workspaceID, path: path)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(WorkspaceIDEDraft.self, from: Data(contentsOf: url))
    }

    public func save(_ draft: WorkspaceIDEDraft) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try encoder.encode(draft).write(
            to: fileURL(workspaceID: draft.workspaceID, path: draft.path),
            options: .atomic
        )
    }

    public func remove(workspaceID: String, path: String) throws {
        let url = fileURL(workspaceID: workspaceID, path: path)
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }

    private func fileURL(workspaceID: String, path: String) -> URL {
        let digest = SHA256.hash(data: Data("\(workspaceID)\u{0}\(path)".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return directory.appendingPathComponent("\(digest).json", isDirectory: false)
    }
}
