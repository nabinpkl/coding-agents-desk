import AgentDeskWire
import Foundation
import os

/// Moves a window between Desktops, for the host's own window placement.
///
/// Lived here with the composer writer that used it twice per write; that writer is gone (ADR-0110)
/// and the standalone helper performs the composer's own move-in and move-back. What remains is
/// `CodexWindowLauncher`, which opens a window and places it, and is host-owned placement.
protocol AgentWindowDesktopMoving {
    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws
}

/// Moves another application's WindowServer window to a stable Space id and proves it landed.
///
/// The bridged SkyLight operation accepts the raw WindowServer id, including a window on an inactive
/// Desktop that has no Accessibility reference. It never changes the active Desktop.
struct BridgedWindowSpaceMover: AgentWindowDesktopMoving {
    private let operation: any BridgedWindowSpaceOperating
    private let membership: any WindowSpaceMembershipReading
    private let verifyAttempts: Int
    private let verifyInterval: TimeInterval
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    init(
        operation: any BridgedWindowSpaceOperating = SkyLightBridgedWindowSpaceOperation(),
        membership: any WindowSpaceMembershipReading = HostWorkspaceWindowSpaceMover(),
        verifyAttempts: Int = Config.claudeWindowMoveVerifyAttempts,
        verifyInterval: TimeInterval = Config.claudeWindowMoveVerifyInterval
    ) {
        self.operation = operation
        self.membership = membership
        self.verifyAttempts = verifyAttempts
        self.verifyInterval = verifyInterval
    }

    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
        do {
            try operation.move(windowID: windowID, toSpaceID: targetSpaceID)
        } catch WorkspaceWindowSpaceMoveError.missingSymbols {
            logger.error("bridged window Space operation is unavailable")
            throw AgentWindowInputReason.windowMoverUnavailable
        } catch {
            logger.error(
                "bridged window move failed window=\(windowID, privacy: .public) targetSpace=\(targetSpaceID, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            throw AgentWindowInputReason.moveFailed
        }
        try verify(windowID: windowID, targetSpaceID: targetSpaceID)
    }

    /// The operation is asynchronous and reports dispatch, not WindowServer convergence. Membership
    /// from the shared SkyLight reader is the success condition for both the move-in and the restore.
    private func verify(windowID: UInt32, targetSpaceID: UInt64) throws {
        var observed: [UInt64] = []
        for attempt in 0..<max(1, verifyAttempts) {
            do {
                observed = try membership.spaceIDs(for: windowID)
            } catch {
                logger.error(
                    "bridged window membership read failed window=\(windowID, privacy: .public) error=\(String(describing: error), privacy: .public)"
                )
                throw AgentWindowInputReason.moveFailed
            }
            if observed == [targetSpaceID] { return }
            if attempt + 1 < verifyAttempts, verifyInterval > 0 {
                Thread.sleep(forTimeInterval: verifyInterval)
            }
        }
        logger.error(
            "bridged window move unverified window=\(windowID, privacy: .public) targetSpace=\(targetSpaceID, privacy: .public) observed=\(observed, privacy: .public)"
        )
        throw AgentWindowInputReason.moveFailed
    }
}
