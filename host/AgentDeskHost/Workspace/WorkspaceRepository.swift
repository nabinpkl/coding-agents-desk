import Foundation

/// Serializes one destination store's bootstrap and writes. The host constructs this with its
/// bundle-scoped URLs; callers never invoke the raw donor import directly.
actor WorkspaceRepository {
    private let donorURL: URL
    private let destinationURL: URL
    private var cachedStore: WorkspaceStore?

    init(donorURL: URL, destinationURL: URL) {
        self.donorURL = donorURL
        self.destinationURL = destinationURL
    }

    func load() throws -> WorkspaceStore {
        if let cachedStore { return cachedStore }
        let loaded = try WorkspaceStore.loadOrImport(from: donorURL, to: destinationURL)
        cachedStore = loaded
        return loaded
    }

    func save(_ store: WorkspaceStore) throws {
        try store.save(to: destinationURL)
        cachedStore = store
    }

    func register(id: UUID = UUID(), root: URL, name: String) throws -> WorkspaceStore {
        let next = try load().registering(id: id, root: root, name: name)
        try save(next)
        return next
    }

    func select(_ id: UUID?) throws -> WorkspaceStore {
        let next = try load().selecting(id)
        try save(next)
        return next
    }
}
