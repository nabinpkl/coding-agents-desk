import Foundation
import AgentDeskWire

enum WorkspaceIDEStateCoordinatorError: Error, Equatable, Sendable {
    case invalidWorkspaceID
    case invalidOperationID
    case invalidPath
    case invalidReorder
    case stateLimitExceeded
    case revisionConflict(currentRevision: UInt64)
}

struct WorkspaceIDEStateSubscription: Hashable, Sendable {
    fileprivate let value: UUID
}

/// Owns the durable cross-device portion of IDE state. Device-local selection, drafts, cursor
/// positions, and pane geometry never enter this store.
actor WorkspaceIDEStateCoordinator {
    typealias Subscriber = @Sendable (WorkspaceIDESharedState) async -> Void

    private struct Record: Codable, Equatable, Sendable {
        var revision: UInt64 = 0
        var orderedOpenPaths: [String] = []
        var expandedDirectoryPaths: [String] = []
        var appliedOperationIDs: [String] = []
    }

    private struct Store: Codable, Equatable, Sendable {
        var records: [String: Record] = [:]
    }

    private struct RegisteredSubscriber: Sendable {
        let workspaceID: String
        let receive: Subscriber
    }

    private static let appliedOperationLimit = 512
    static let maximumOpenPaths = 256
    static let maximumExpandedDirectoryPaths = 2_048
    static let maximumPathBytes = 4 * 1_024
    static let maximumOperationIDBytes = 512

    private let storeURL: URL
    private var loadedStore: Store?
    private var subscribers: [WorkspaceIDEStateSubscription: RegisteredSubscriber] = [:]

    init(storeURL: URL) {
        self.storeURL = storeURL
    }

    func snapshot(workspaceID: String) throws -> WorkspaceIDESharedState {
        let workspaceID = try validatedWorkspaceID(workspaceID)
        let record = try load().records[workspaceID] ?? Record()
        return state(workspaceID: workspaceID, record: record)
    }

    func subscribe(workspaceID: String, receive: @escaping Subscriber) -> WorkspaceIDEStateSubscription {
        let token = WorkspaceIDEStateSubscription(value: UUID())
        subscribers[token] = RegisteredSubscriber(workspaceID: workspaceID, receive: receive)
        return token
    }

    func subscribeAndSnapshot(
        workspaceID rawWorkspaceID: String,
        receive: @escaping Subscriber
    ) throws -> (WorkspaceIDEStateSubscription, WorkspaceIDESharedState) {
        let workspaceID = try validatedWorkspaceID(rawWorkspaceID)
        let token = WorkspaceIDEStateSubscription(value: UUID())
        subscribers[token] = RegisteredSubscriber(workspaceID: workspaceID, receive: receive)
        let record = try load().records[workspaceID] ?? Record()
        return (token, state(workspaceID: workspaceID, record: record))
    }

    func unsubscribe(_ token: WorkspaceIDEStateSubscription) {
        subscribers.removeValue(forKey: token)
    }

    func apply(
        workspaceID rawWorkspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async throws -> WorkspaceIDESharedState {
        let workspaceID = try validatedWorkspaceID(rawWorkspaceID)
        guard !operationID.value.isEmpty,
              operationID.value.utf8.count <= Self.maximumOperationIDBytes else {
            throw WorkspaceIDEStateCoordinatorError.invalidOperationID
        }

        var store = try load()
        var record = store.records[workspaceID] ?? Record()
        if record.appliedOperationIDs.contains(operationID.value) {
            return state(workspaceID: workspaceID, record: record)
        }
        guard record.revision == baseRevision else {
            throw WorkspaceIDEStateCoordinatorError.revisionConflict(currentRevision: record.revision)
        }

        let changed = try apply(operation, to: &record)
        if changed { record.revision &+= 1 }
        record.appliedOperationIDs.append(operationID.value)
        if record.appliedOperationIDs.count > Self.appliedOperationLimit {
            record.appliedOperationIDs.removeFirst(record.appliedOperationIDs.count - Self.appliedOperationLimit)
        }
        store.records[workspaceID] = record
        try persist(store)

        let snapshot = state(workspaceID: workspaceID, record: record)
        if changed {
            for subscriber in subscribers.values where subscriber.workspaceID == workspaceID {
                await subscriber.receive(snapshot)
            }
        }
        return snapshot
    }

    private func apply(_ operation: WorkspaceIDEOperation, to record: inout Record) throws -> Bool {
        switch operation {
        case .open(let rawPath):
            let path = try validatedRelativePath(rawPath)
            guard !record.orderedOpenPaths.contains(path) else { return false }
            guard record.orderedOpenPaths.count < Self.maximumOpenPaths else {
                throw WorkspaceIDEStateCoordinatorError.stateLimitExceeded
            }
            record.orderedOpenPaths.append(path)
            return true
        case .close(let rawPath):
            let path = try validatedRelativePath(rawPath)
            let priorCount = record.orderedOpenPaths.count
            record.orderedOpenPaths.removeAll { $0 == path }
            return record.orderedOpenPaths.count != priorCount
        case .reorder(let rawPaths):
            guard rawPaths.count <= Self.maximumOpenPaths else {
                throw WorkspaceIDEStateCoordinatorError.stateLimitExceeded
            }
            let paths = try rawPaths.map(validatedRelativePath)
            guard Set(paths).count == paths.count,
                  Set(paths) == Set(record.orderedOpenPaths) else {
                throw WorkspaceIDEStateCoordinatorError.invalidReorder
            }
            guard paths != record.orderedOpenPaths else { return false }
            record.orderedOpenPaths = paths
            return true
        case .expand(let rawPath):
            let path = try validatedRelativePath(rawPath)
            guard !record.expandedDirectoryPaths.contains(path) else { return false }
            guard record.expandedDirectoryPaths.count < Self.maximumExpandedDirectoryPaths else {
                throw WorkspaceIDEStateCoordinatorError.stateLimitExceeded
            }
            record.expandedDirectoryPaths.append(path)
            return true
        case .collapse(let rawPath):
            let path = try validatedRelativePath(rawPath)
            let priorCount = record.expandedDirectoryPaths.count
            record.expandedDirectoryPaths.removeAll { $0 == path }
            return record.expandedDirectoryPaths.count != priorCount
        }
    }

    private func validatedWorkspaceID(_ raw: String) throws -> String {
        guard let id = UUID(uuidString: raw) else {
            throw WorkspaceIDEStateCoordinatorError.invalidWorkspaceID
        }
        return id.uuidString
    }

    private func validatedRelativePath(_ path: String) throws -> String {
        guard !path.isEmpty,
              !path.hasPrefix("/"),
              path.utf8.count <= Self.maximumPathBytes else {
            throw WorkspaceIDEStateCoordinatorError.invalidPath
        }
        let components = path.components(separatedBy: "/")
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") }) else {
            throw WorkspaceIDEStateCoordinatorError.invalidPath
        }
        return components.joined(separator: "/")
    }

    private func state(workspaceID: String, record: Record) -> WorkspaceIDESharedState {
        WorkspaceIDESharedState(
            workspaceID: workspaceID,
            revision: record.revision,
            orderedOpenPaths: record.orderedOpenPaths,
            expandedDirectoryPaths: record.expandedDirectoryPaths
        )
    }

    private func load() throws -> Store {
        if let loadedStore { return loadedStore }
        guard FileManager.default.fileExists(atPath: storeURL.path) else {
            let empty = Store()
            loadedStore = empty
            return empty
        }
        let decoded = try JSONDecoder().decode(Store.self, from: Data(contentsOf: storeURL))
        loadedStore = decoded
        return decoded
    }

    private func persist(_ store: Store) throws {
        try FileManager.default.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(store).write(to: storeURL, options: .atomic)
        loadedStore = store
    }
}
