import CoreGraphics
import Foundation

enum WorkspaceMutation: Sendable {
    case register(id: UUID, root: URL, name: String)
    case add(Workspace)
    case select(UUID?)
    case remove(UUID)
    case reorder([UUID])
    case setDesktopAssignment(WorkspaceDesktopAssignment, workspaceID: UUID)
    case reconcileDesktopAssignments([UInt64: WorkspaceDesktopAssignment])
    case setDesktopAutoAssign(Bool, workspaceID: UUID)
    case setSidebarWidth(CGFloat, screenWidth: CGFloat?)
    case setTextZoom(WorkspaceTextZoom)
    case setEditorFrame(CGRect, workspaceID: UUID)
}

struct WorkspaceCoordinatorSubscription: Hashable, Sendable {
    fileprivate let value: UUID
}

/// Sole runtime mutation owner for the registered workspace store. Consumers retain snapshots for
/// presentation only and submit typed mutations here; persistence and fan-out happen in one turn.
actor WorkspaceCoordinator {
    typealias Subscriber = @Sendable (WorkspaceStore) async -> Void

    private let repository: WorkspaceRepository
    private var cachedStore: WorkspaceStore?
    private var subscribers: [WorkspaceCoordinatorSubscription: Subscriber] = [:]

    init(repository: WorkspaceRepository) {
        self.repository = repository
    }

    func snapshot() async throws -> WorkspaceStore {
        if let cachedStore { return cachedStore }
        let loaded = try await repository.load()
        cachedStore = loaded
        return loaded
    }

    func workspace(id: UUID) async throws -> Workspace? {
        try await snapshot().workspace(id: id)
    }

    func contains(workspaceID rawID: String) async throws -> Bool {
        guard let id = UUID(uuidString: rawID) else { return false }
        return try await workspace(id: id) != nil
    }

    func subscribe(receive: @escaping Subscriber) -> WorkspaceCoordinatorSubscription {
        let token = WorkspaceCoordinatorSubscription(value: UUID())
        subscribers[token] = receive
        return token
    }

    func unsubscribe(_ token: WorkspaceCoordinatorSubscription) {
        subscribers.removeValue(forKey: token)
    }

    @discardableResult
    func apply(_ mutation: WorkspaceMutation) async throws -> WorkspaceStore {
        let current = try await snapshot()
        let next = try updated(current, mutation: mutation)
        guard next != current else { return current }
        try await repository.save(next)
        cachedStore = next
        for subscriber in subscribers.values {
            await subscriber(next)
        }
        return next
    }

    private func updated(_ current: WorkspaceStore, mutation: WorkspaceMutation) throws -> WorkspaceStore {
        switch mutation {
        case .register(let id, let root, let name):
            return try current.registering(id: id, root: root, name: name)
        case .add(let workspace):
            return try current.adding(workspace)
        case .select(let id):
            return try current.selecting(id)
        case .remove(let id):
            var next = current
            next.remove(id: id)
            return next
        case .reorder(let ids):
            var next = current
            next.setOrder(ids)
            return next
        case .setDesktopAssignment(let assignment, let workspaceID):
            var next = current
            next.setDesktopAssignment(assignment, for: workspaceID)
            return next
        case .reconcileDesktopAssignments(let assignmentsBySpaceID):
            var next = current
            next.reconcileDesktopAssignments(assignmentsBySpaceID)
            return next
        case .setDesktopAutoAssign(let enabled, let workspaceID):
            var next = current
            next.setDesktopAutoAssign(enabled, for: workspaceID)
            return next
        case .setSidebarWidth(let width, let screenWidth):
            var next = current
            next.setSidebarWidth(width, screenWidth: screenWidth)
            return next
        case .setTextZoom(let zoom):
            var next = current
            next.textZoom = zoom
            return next
        case .setEditorFrame(let frame, let workspaceID):
            var next = current
            next.setEditorFrame(frame, for: workspaceID)
            return next
        }
    }
}
