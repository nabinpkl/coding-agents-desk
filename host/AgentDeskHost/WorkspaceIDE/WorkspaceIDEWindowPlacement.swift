import Foundation

struct WorkspaceIDEWindowPlacement: Codable, Equatable, Sendable {
    let desktop: WorkspaceDesktopAssignment
}

protocol WorkspaceIDEWindowPlacementStoring: AnyObject {
    func load() throws -> WorkspaceIDEWindowPlacement?
    func save(_ placement: WorkspaceIDEWindowPlacement) throws
}

final class WorkspaceIDEWindowPlacementFileStore: WorkspaceIDEWindowPlacementStoring {
    private let url: URL
    private let fileManager: FileManager

    init(url: URL, fileManager: FileManager = .default) {
        self.url = url
        self.fileManager = fileManager
    }

    func load() throws -> WorkspaceIDEWindowPlacement? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(
            WorkspaceIDEWindowPlacement.self,
            from: Data(contentsOf: url)
        )
    }

    func save(_ placement: WorkspaceIDEWindowPlacement) throws {
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(placement).write(to: url, options: .atomic)
    }
}

enum WorkspaceWindowSpaceMoveError: Error, Equatable, CustomStringConvertible {
    case missingSymbols
    case unavailable(String)

    var description: String {
        switch self {
        case .missingSymbols:
            return "SkyLight window Space symbols unavailable"
        case .unavailable(let message):
            return message
        }
    }
}

protocol WorkspaceWindowSpaceMoving {
    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws
    func spaceIDs(for windowID: UInt32) throws -> [UInt64]
}

enum WorkspaceIDEWindowPlacementError: Error, Equatable, CustomStringConvertible {
    case desktopAuditUnavailable(String)
    case missingTargetDesktop(displayID: String, ordinal: Int)
    case moveFailed(windowID: UInt32, targetSpaceID: UInt64, reason: String)
    case verificationMismatch(windowID: UInt32, targetSpaceID: UInt64, observedSpaceIDs: [UInt64])

    var description: String {
        switch self {
        case .desktopAuditUnavailable(let diagnostic):
            return "Workspace IDE desktop audit unavailable: \(diagnostic)"
        case .missingTargetDesktop(let displayID, let ordinal):
            return "Workspace IDE Desktop \(ordinal + 1) is unavailable on display \(displayID)"
        case .moveFailed(let windowID, let targetSpaceID, let reason):
            return "Move Workspace IDE window \(windowID) to Space \(targetSpaceID) failed: \(reason)"
        case .verificationMismatch(let windowID, let targetSpaceID, let observedSpaceIDs):
            return "Move Workspace IDE window \(windowID) expected Space [\(targetSpaceID)] but observed \(observedSpaceIDs)"
        }
    }
}

enum WorkspaceIDEWindowPlacementRestore: Equatable {
    case noSavedPlacement
    case restored(WorkspaceDesktopAssignment)
}

/// Persists the IDE window's own Desktop independently from the workspace displayed inside it.
/// The exact WindowServer Space id is authoritative; display plus ordinal only repairs topology
/// churn when that exact id disappeared between launches.
final class WorkspaceIDEWindowPlacementCoordinator {
    private let store: WorkspaceIDEWindowPlacementStoring
    private let desktopAudit: WorkspaceDesktopAuditing
    private let mover: WorkspaceWindowSpaceMoving

    init(
        store: WorkspaceIDEWindowPlacementStoring,
        desktopAudit: WorkspaceDesktopAuditing,
        mover: WorkspaceWindowSpaceMoving
    ) {
        self.store = store
        self.desktopAudit = desktopAudit
        self.mover = mover
    }

    @discardableResult
    func record(windowID: UInt32) throws -> WorkspaceDesktopAssignment? {
        let observed = try mover.spaceIDs(for: windowID)
        guard observed.count == 1 else { return nil }
        let snapshot = desktopAudit.snapshot()
        if let diagnostic = snapshot.diagnostic {
            throw WorkspaceIDEWindowPlacementError.desktopAuditUnavailable(diagnostic)
        }
        guard let desktop = snapshot.desktops.first(where: { $0.id == observed[0] }) else {
            return nil
        }
        let assignment = WorkspaceDesktopAssignment(desktop)
        try store.save(WorkspaceIDEWindowPlacement(desktop: assignment))
        return assignment
    }

    func restore(windowID: UInt32) throws -> WorkspaceIDEWindowPlacementRestore {
        guard let saved = try store.load() else { return .noSavedPlacement }
        let snapshot = desktopAudit.snapshot()
        if let diagnostic = snapshot.diagnostic {
            throw WorkspaceIDEWindowPlacementError.desktopAuditUnavailable(diagnostic)
        }
        guard let target = resolve(saved.desktop, in: snapshot.desktops) else {
            throw WorkspaceIDEWindowPlacementError.missingTargetDesktop(
                displayID: saved.desktop.displayID,
                ordinal: saved.desktop.ordinal
            )
        }
        do {
            try mover.move(windowID: windowID, toSpaceID: target.id)
        } catch {
            throw WorkspaceIDEWindowPlacementError.moveFailed(
                windowID: windowID,
                targetSpaceID: target.id,
                reason: String(describing: error)
            )
        }
        try verify(windowID: windowID, targetSpaceID: target.id)
        let resolved = WorkspaceDesktopAssignment(target)
        if resolved != saved.desktop {
            try store.save(WorkspaceIDEWindowPlacement(desktop: resolved))
        }
        return .restored(resolved)
    }

    func verify(windowID: UInt32, targetSpaceID: UInt64) throws {
        let observed = try mover.spaceIDs(for: windowID)
        guard observed == [targetSpaceID] else {
            throw WorkspaceIDEWindowPlacementError.verificationMismatch(
                windowID: windowID,
                targetSpaceID: targetSpaceID,
                observedSpaceIDs: observed
            )
        }
    }

    private func resolve(
        _ assignment: WorkspaceDesktopAssignment,
        in desktops: [WorkspaceDesktop]
    ) -> WorkspaceDesktop? {
        desktops.first {
            $0.id == assignment.spaceID && $0.displayID == assignment.displayID
        } ?? desktops.first {
            $0.displayID == assignment.displayID && $0.ordinal == assignment.ordinal
        }
    }
}
