import Foundation

struct Workspace: Codable, Equatable, Identifiable {
    let id: UUID
    let root: URL
    let name: String

    private init(id: UUID, persistedRoot: URL, name: String) {
        self.id = id
        self.root = persistedRoot
        self.name = name
    }

    /// Registers a root that is currently safe to browse. This is intentionally stricter than
    /// decoding persisted state, because a workspace can disappear after it has been saved.
    static func registering(
        id: UUID = UUID(),
        root: URL,
        name: String,
        fileManager: FileManager = .default
    ) throws -> Workspace {
        let persistedRoot = try validatedRegistrationRoot(root, fileManager: fileManager)
        return Workspace(id: id, persistedRoot: persistedRoot, name: name)
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self = Workspace(
            id: try container.decode(UUID.self, forKey: .id),
            persistedRoot: try Self.persistedRoot(try container.decode(URL.self, forKey: .root)),
            name: try container.decode(String.self, forKey: .name)
        )
    }

    private static func persistedRoot(_ root: URL) throws -> URL {
        guard root.isFileURL, root.path.hasPrefix("/") else {
            throw WorkspaceStoreError.invalidWorkspaceRoot(root)
        }
        return root.standardizedFileURL
    }

    private static func validatedRegistrationRoot(_ root: URL, fileManager: FileManager) throws -> URL {
        let persistedRoot = try persistedRoot(root)
        if (try? fileManager.destinationOfSymbolicLink(atPath: persistedRoot.path)) != nil {
            throw WorkspaceStoreError.symbolicLinkWorkspaceRoot(persistedRoot)
        }

        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: persistedRoot.path, isDirectory: &isDirectory) else {
            throw WorkspaceStoreError.workspaceRootDoesNotExist(persistedRoot)
        }
        guard isDirectory.boolValue else {
            throw WorkspaceStoreError.workspaceRootIsNotDirectory(persistedRoot)
        }
        return persistedRoot
    }
}
