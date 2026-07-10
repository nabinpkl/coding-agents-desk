import Foundation

enum WorkspaceStoreError: Error, Equatable {
    case duplicateWorkspaceIdentifier(UUID)
    case duplicateWorkspaceRoot(URL)
    case invalidWorkspaceRoot(URL)
    case workspaceRootDoesNotExist(URL)
    case workspaceRootIsNotDirectory(URL)
    case symbolicLinkWorkspaceRoot(URL)
    case unknownActiveWorkspace(UUID)
}

/// Ordered, host-local workspace roots plus the currently selected workspace.
/// Runtime session and presentation state intentionally live outside this store.
struct WorkspaceStore: Codable, Equatable {
    private(set) var workspaces: [Workspace]
    private(set) var activeID: UUID?

    init() {
        workspaces = []
        activeID = nil
    }

    fileprivate init(persistedWorkspaces: [Workspace], activeID: UUID? = nil) throws {
        workspaces = persistedWorkspaces
        self.activeID = activeID
        try validate()
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            persistedWorkspaces: try container.decode([Workspace].self, forKey: .workspaces),
            activeID: try container.decodeIfPresent(UUID.self, forKey: .activeID)
        )
    }

    var active: Workspace? {
        guard let activeID else { return nil }
        return workspaces.first { $0.id == activeID }
    }

    func workspace(id: UUID) -> Workspace? {
        workspaces.first { $0.id == id }
    }

    func registering(
        id: UUID = UUID(),
        root: URL,
        name: String,
        fileManager: FileManager = .default
    ) throws -> WorkspaceStore {
        try adding(Workspace.registering(id: id, root: root, name: name, fileManager: fileManager))
    }

    func adding(_ workspace: Workspace, makeActive: Bool = true) throws -> WorkspaceStore {
        try WorkspaceStore(
            persistedWorkspaces: workspaces + [workspace],
            activeID: makeActive ? workspace.id : activeID
        )
    }

    func selecting(_ id: UUID?) throws -> WorkspaceStore {
        try WorkspaceStore(persistedWorkspaces: workspaces, activeID: id)
    }

    private func validate() throws {
        try Self.validate(workspaces: workspaces, activeID: activeID)
    }

    private static func validate(workspaces: [Workspace], activeID: UUID?) throws {
        var identifiers = Set<UUID>()
        var roots = Set<URL>()
        for workspace in workspaces {
            guard identifiers.insert(workspace.id).inserted else {
                throw WorkspaceStoreError.duplicateWorkspaceIdentifier(workspace.id)
            }
            guard roots.insert(workspace.root).inserted else {
                throw WorkspaceStoreError.duplicateWorkspaceRoot(workspace.root)
            }
        }
        if let activeID, !identifiers.contains(activeID) {
            throw WorkspaceStoreError.unknownActiveWorkspace(activeID)
        }
    }
}

extension WorkspaceStore {
    fileprivate static func load(from url: URL) throws -> WorkspaceStore {
        try JSONDecoder().decode(WorkspaceStore.self, from: Data(contentsOf: url))
    }

    func save(to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }

    static func loadOrImport(from donorURL: URL, to destinationURL: URL) throws -> WorkspaceStore {
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            return try load(from: destinationURL)
        }
        guard FileManager.default.fileExists(atPath: donorURL.path) else {
            return WorkspaceStore()
        }

        let donor = try JSONDecoder().decode(
            AgentWorkspaceIDEDonorStore.self,
            from: Data(contentsOf: donorURL)
        )
        var imported = WorkspaceStore()
        for donorWorkspace in donor.workspaces {
            // Validate the donor root (existence, directory, not a symlink) but do not carry over
            // any active selection: import leaves `activeID` nil so the host chooses the active
            // workspace explicitly rather than inheriting the donor's last-focused one.
            let workspace = try Workspace.registering(
                id: donorWorkspace.id,
                root: donorWorkspace.root,
                name: donorWorkspace.name
            )
            imported = try imported.adding(workspace, makeActive: false)
        }
        try imported.save(to: destinationURL)
        return imported
    }
}

private struct AgentWorkspaceIDEDonorStore: Decodable {
    let workspaces: [AgentWorkspaceIDEDonorWorkspace]
}

private struct AgentWorkspaceIDEDonorWorkspace: Decodable {
    let id: UUID
    let root: URL
    let name: String
}
