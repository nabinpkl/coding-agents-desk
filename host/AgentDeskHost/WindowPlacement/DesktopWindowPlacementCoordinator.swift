import CoreGraphics
import Foundation
import WindowPlacement

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

/// Which Desktops a window currently belongs to, straight from SkyLight.
///
/// Split from moving because reading membership is universal while moving is not: SkyLight can report
/// any window's Desktop, but it can only MOVE windows this host's connection owns. A third-party
/// window is moved by `YabaiWindowSpaceMover`, which verifies through this same reader so the answer
/// agrees with the desktop audit.
protocol WindowSpaceMembershipReading: Sendable {
    func spaceIDs(for windowID: UInt32) throws -> [UInt64]
}

/// `Sendable` because the move is a stateless SkyLight call: the sole implementation
/// (`HostWorkspaceWindowSpaceMover`) holds no state, and the same SkyLight binding already backs the
/// off-main desktop audit.
///
/// HOST-OWNED WINDOWS ONLY. `SLSMoveWindowsToManagedSpace` is honoured for the calling connection's
/// own windows and silently ignored for anything else, so a third-party window "moves" successfully
/// and stays exactly where it was (ADR-0059).
protocol WorkspaceWindowSpaceMoving: WindowSpaceMembershipReading {
    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws
}

enum DesktopWindowPlacementError: Error, Equatable, CustomStringConvertible {
    case windowNumberUnavailable
    case desktopAuditUnavailable(String)
    case missingTargetDesktop(displayID: String, ordinal: Int)
    case moveFailed(windowID: UInt32, targetSpaceID: UInt64, reason: String)
    case verificationMismatch(windowID: UInt32, targetSpaceID: UInt64, observedSpaceIDs: [UInt64])

    var description: String {
        switch self {
        case .windowNumberUnavailable:
            return "AppKit returned no window number"
        case .desktopAuditUnavailable(let diagnostic):
            return "Window Desktop audit unavailable: \(diagnostic)"
        case .missingTargetDesktop(let displayID, let ordinal):
            return "Desktop \(ordinal + 1) is unavailable on display \(displayID)"
        case .moveFailed(let windowID, let targetSpaceID, let reason):
            return "Move window \(windowID) to Space \(targetSpaceID) failed: \(reason)"
        case .verificationMismatch(let windowID, let targetSpaceID, let observedSpaceIDs):
            return "Move window \(windowID) expected Space [\(targetSpaceID)] but observed \(observedSpaceIDs)"
        }
    }
}

/// The one host-side authority for observing, resolving, moving, and verifying app-owned windows.
/// Presentation stores own durability; this coordinator owns only WindowServer truth.
final class DesktopWindowPlacementCoordinator: Sendable {
    private let desktopAudit: WorkspaceDesktopAuditing
    private let mover: WorkspaceWindowSpaceMoving

    init(
        desktopAudit: WorkspaceDesktopAuditing,
        mover: WorkspaceWindowSpaceMoving
    ) {
        self.desktopAudit = desktopAudit
        self.mover = mover
    }

    func capture(windowID: UInt32, frame: CGRect) throws -> WorkspaceWindowPlacement? {
        let observed = try mover.spaceIDs(for: windowID)
        guard observed.count == 1 else { return nil }
        let snapshot = desktopAudit.snapshot()
        if let diagnostic = snapshot.diagnostic {
            throw DesktopWindowPlacementError.desktopAuditUnavailable(diagnostic)
        }
        guard let desktop = snapshot.desktops.first(where: { $0.id == observed[0] }) else {
            return nil
        }
        return WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(desktop),
            frame: frame
        )
    }

    func restore(
        _ saved: WorkspaceWindowPlacement,
        windowID: UInt32,
        applyFrame: (CGRect) -> Void
    ) throws -> WorkspaceWindowPlacement {
        let snapshot = desktopAudit.snapshot()
        if let diagnostic = snapshot.diagnostic {
            throw DesktopWindowPlacementError.desktopAuditUnavailable(diagnostic)
        }
        guard let target = resolve(saved.desktop, in: snapshot.desktops) else {
            throw DesktopWindowPlacementError.missingTargetDesktop(
                displayID: saved.desktop.displayID,
                ordinal: saved.desktop.ordinal
            )
        }
        applyFrame(saved.frame)
        do {
            try mover.move(windowID: windowID, toSpaceID: target.id)
        } catch {
            throw DesktopWindowPlacementError.moveFailed(
                windowID: windowID,
                targetSpaceID: target.id,
                reason: String(describing: error)
            )
        }
        try verify(windowID: windowID, targetSpaceID: target.id)
        return WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(target),
            frame: saved.frame
        )
    }

    func verify(windowID: UInt32, targetSpaceID: UInt64) throws {
        let observed = try mover.spaceIDs(for: windowID)
        guard observed == [targetSpaceID] else {
            throw DesktopWindowPlacementError.verificationMismatch(
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
            $0.id == assignment.spaceID
        } ?? desktops.first {
            $0.displayID == assignment.displayID && $0.ordinal == assignment.ordinal
        }
    }
}
