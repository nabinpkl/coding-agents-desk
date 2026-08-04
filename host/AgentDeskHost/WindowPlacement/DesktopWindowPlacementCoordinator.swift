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

/// `Sendable` because the move is a stateless SkyLight call: the sole implementation
/// (`HostWorkspaceWindowSpaceMover`) holds no state, and the same SkyLight binding already backs the
/// off-main desktop audit. Composer sync runs this whole path off the main thread so a blocking
/// Accessibility round trip cannot stall the UI.
protocol WorkspaceWindowSpaceMoving: Sendable {
    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws
    func spaceIDs(for windowID: UInt32) throws -> [UInt64]
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

    /// Moves a window to a Desktop and confirms it landed, without touching its frame.
    ///
    /// `restore(_:windowID:applyFrame:)` is the path for windows this host owns, where the saved frame
    /// is ours to reapply. Another application's window is not ours to resize, so this carries the
    /// Space move alone.
    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
        do {
            try mover.move(windowID: windowID, toSpaceID: targetSpaceID)
        } catch {
            throw DesktopWindowPlacementError.moveFailed(
                windowID: windowID,
                targetSpaceID: targetSpaceID,
                reason: String(describing: error)
            )
        }
        try verify(windowID: windowID, targetSpaceID: targetSpaceID)
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
