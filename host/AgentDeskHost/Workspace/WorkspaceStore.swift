import CoreGraphics
import Foundation

public enum WorkspaceStoreError: Error, Equatable, Sendable {
    case duplicateWorkspaceIdentifier(UUID)
    case duplicateWorkspaceRoot(URL)
    case invalidWorkspaceRoot(URL)
    case workspaceRootDoesNotExist(URL)
    case workspaceRootIsNotDirectory(URL)
    case symbolicLinkWorkspaceRoot(URL)
    case unknownActiveWorkspace(UUID)
}

/// The persisted set of workspaces, the active one, and most-recently-used order. Ported from the
/// agent-workspace-ide donor (rich per-workspace state + pure mutating ops) and merged with
/// AgentDesk's validated registration and one-time donor import. Persistence is the only I/O.
public struct WorkspaceStore: Codable, Equatable, Sendable {
    public var workspaces: [Workspace]
    public var activeID: UUID?
    /// Workspace ids in most-recently-active first order.
    public var recentOrder: [UUID]
    /// Shell-wide sidebar width preference (a workspace-shell preference, unlike per-workspace pins).
    public var sidebarWidth: CGFloat
    /// Shell-wide text zoom shared by the sidebar, viewer, and switcher.
    public var textZoom: WorkspaceTextZoom

    public init(
        workspaces: [Workspace] = [],
        activeID: UUID? = nil,
        recentOrder: [UUID] = [],
        sidebarWidth: CGFloat = SidebarWidth.defaultValue,
        textZoom: WorkspaceTextZoom = WorkspaceTextZoom()
    ) {
        self.workspaces = workspaces
        self.activeID = activeID
        self.recentOrder = recentOrder
        self.sidebarWidth = SidebarWidth.clamped(sidebarWidth)
        self.textZoom = textZoom
    }

    public var active: Workspace? {
        guard let activeID else { return nil }
        return workspaces.first { $0.id == activeID }
    }

    public func workspace(id: UUID) -> Workspace? {
        workspaces.first { $0.id == id }
    }

    private enum CodingKeys: String, CodingKey {
        case workspaces, activeID, recentOrder, sidebarWidth, textZoom
    }

    /// Decode tolerantly so a store written before shell preferences existed still loads.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = try container.decode([Workspace].self, forKey: .workspaces)
        activeID = try container.decodeIfPresent(UUID.self, forKey: .activeID)
        recentOrder = try container.decodeIfPresent([UUID].self, forKey: .recentOrder) ?? []
        let decodedWidth = try container.decodeIfPresent(CGFloat.self, forKey: .sidebarWidth) ?? SidebarWidth.defaultValue
        sidebarWidth = SidebarWidth.clamped(decodedWidth)
        textZoom = try container.decodeIfPresent(WorkspaceTextZoom.self, forKey: .textZoom) ?? WorkspaceTextZoom()
        // AgentDesk contract: a persisted store tolerates a workspace whose root has since vanished,
        // but rejects an activeID / duplicate ids/roots that make the store internally inconsistent.
        try validate()
    }
}

// MARK: - AgentDesk validated, immutable-style ops (used by WorkspaceRepository + the .files lane)

public extension WorkspaceStore {
    func registering(id: UUID = UUID(), root: URL, name: String, fileManager: FileManager = .default) throws -> WorkspaceStore {
        try adding(Workspace.registering(id: id, root: root, name: name, fileManager: fileManager))
    }

    func adding(_ workspace: Workspace, makeActive: Bool = true) throws -> WorkspaceStore {
        var copy = self
        copy.workspaces.append(workspace)
        if makeActive { copy.setActive(workspace.id) }
        try copy.validate()
        return copy
    }

    func selecting(_ id: UUID?) throws -> WorkspaceStore {
        var copy = self
        if let id {
            guard copy.workspaces.contains(where: { $0.id == id }) else {
                throw WorkspaceStoreError.unknownActiveWorkspace(id)
            }
            copy.setActive(id)
        } else {
            copy.clearActive()
        }
        try copy.validate()
        return copy
    }

    private func validate() throws {
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

// MARK: - Donor pure mutating ops (used by WorkspaceSession)

public extension WorkspaceStore {
    @discardableResult
    mutating func add(_ workspace: Workspace) -> Workspace {
        workspaces.append(workspace)
        setActive(workspace.id)
        return workspace
    }

    mutating func remove(id: UUID) {
        workspaces.removeAll { $0.id == id }
        recentOrder.removeAll { $0 == id }
        if activeID == id { activeID = recentOrder.first ?? workspaces.first?.id }
    }

    mutating func setOrder(_ ids: [UUID]) {
        let byID = Dictionary(workspaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var reordered = ids.compactMap { byID[$0] }
        let placed = Set(reordered.map(\.id))
        reordered += workspaces.filter { !placed.contains($0.id) }
        workspaces = reordered
    }

    @discardableResult
    mutating func orderByDesktopEnumeration(_ desktops: [WorkspaceDesktop]) -> Bool {
        let indexed = workspaces.enumerated().map { (offset: $0.offset, workspace: $0.element) }
        let ordered = indexed.sorted { lhs, rhs in
            switch (desktopOrder(for: lhs.workspace, desktops: desktops), desktopOrder(for: rhs.workspace, desktops: desktops)) {
            case let (left?, right?) where left != right: return left < right
            case (_?, nil): return true
            case (nil, _?): return false
            default: return lhs.offset < rhs.offset
            }
        }.map(\.workspace)
        guard ordered.map(\.id) != workspaces.map(\.id) else { return false }
        workspaces = ordered
        return true
    }

    mutating func setActive(_ id: UUID) {
        guard workspaces.contains(where: { $0.id == id }) else { return }
        activeID = id
        recentOrder.removeAll { $0 == id }
        recentOrder.insert(id, at: 0)
    }

    mutating func clearActive() { activeID = nil }

    mutating func setMode(_ mode: WorkspaceMode, for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].lastMode = mode
    }

    mutating func setSidebarPinned(_ pinned: Bool, for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].sidebarPinned = pinned
    }

    mutating func setTopBarPinned(_ pinned: Bool, for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].topBarPinned = pinned
    }

    mutating func setDesktopAutoAssign(_ enabled: Bool, for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].desktopAutoAssignEnabled = enabled
    }

    mutating func setSidebarWidth(_ width: CGFloat, screenWidth: CGFloat? = nil) {
        sidebarWidth = SidebarWidth.clamped(width, screenWidth: screenWidth)
    }

    mutating func setEditorFrame(_ frame: CGRect, for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].editorFrame = frame
    }

    mutating func setDesktopAssignment(_ assignment: WorkspaceDesktopAssignment, for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].desktopAssignment = assignment
    }

    mutating func clearDesktopAssignment(for id: UUID) {
        guard let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        workspaces[index].desktopAssignment = nil
    }

    func desktopAssignment(for id: UUID) -> WorkspaceDesktopAssignment? {
        workspace(id: id)?.desktopAssignment
    }

    func workspaceIDsAssigned(to assignment: WorkspaceDesktopAssignment) -> [UUID] {
        let exact = workspaces.compactMap { workspace -> UUID? in
            guard workspace.desktopAssignment?.spaceID == assignment.spaceID,
                  workspace.desktopAssignment?.displayID == assignment.displayID else { return nil }
            return workspace.id
        }
        if !exact.isEmpty { return exact }
        return workspaces.compactMap { workspace -> UUID? in
            guard workspace.desktopAssignment?.displayID == assignment.displayID,
                  workspace.desktopAssignment?.ordinal == assignment.ordinal else { return nil }
            return workspace.id
        }
    }

    func preferredWorkspaceID(assignedTo assignment: WorkspaceDesktopAssignment, candidates: [UUID]? = nil) -> UUID? {
        let assigned = Set(workspaceIDsAssigned(to: assignment))
        let candidateSet = candidates.map(Set.init) ?? assigned
        let assignedCandidates = candidateSet.intersection(assigned)
        let eligible = assignedCandidates.isEmpty ? candidateSet : assignedCandidates
        guard !eligible.isEmpty else { return nil }
        if let recent = recentOrder.first(where: { eligible.contains($0) }) { return recent }
        return workspaces.first(where: { eligible.contains($0.id) })?.id
    }

    func workspaceAssigned(to assignment: WorkspaceDesktopAssignment) -> Workspace? {
        guard let id = preferredWorkspaceID(assignedTo: assignment) else { return nil }
        return workspace(id: id)
    }

    private func desktopOrder(for workspace: Workspace, desktops: [WorkspaceDesktop]) -> Int? {
        guard let assignment = workspace.desktopAssignment else { return nil }
        if let exact = desktops.firstIndex(where: { $0.id == assignment.spaceID && $0.displayID == assignment.displayID }) {
            return exact
        }
        return desktops.firstIndex { $0.displayID == assignment.displayID && $0.ordinal == assignment.ordinal }
    }

    mutating func resetModesToEditor() {
        for index in workspaces.indices { workspaces[index].lastMode = .editor }
    }
}

// MARK: - Persistence + one-time donor import (the only I/O)

public extension WorkspaceStore {
    static func load(from url: URL) throws -> WorkspaceStore {
        try JSONDecoder().decode(WorkspaceStore.self, from: Data(contentsOf: url))
    }

    func save(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }

    /// Load the destination store, or import the retired agent-workspace-ide donor once on first run
    /// (validating each root, leaving `activeID` nil so the host chooses the active workspace).
    static func loadOrImport(from donorURL: URL, to destinationURL: URL) throws -> WorkspaceStore {
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            return try load(from: destinationURL)
        }
        guard FileManager.default.fileExists(atPath: donorURL.path) else { return WorkspaceStore() }

        let donor = try JSONDecoder().decode(AgentWorkspaceIDEDonorStore.self, from: Data(contentsOf: donorURL))
        var imported = WorkspaceStore()
        for donorWorkspace in donor.workspaces {
            let workspace = try Workspace.registering(id: donorWorkspace.id, root: donorWorkspace.root, name: donorWorkspace.name)
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
