import AgentDeskWire
import Foundation
import os

/// Moves ANOTHER application's window to a Desktop, and confirms it landed.
///
/// `HostWorkspaceWindowSpaceMover`'s SkyLight call only moves windows the host's own connection owns.
/// WindowServer silently ignores `SLSMoveWindowsToManagedSpace` for a third-party window: the call
/// returns, nothing moves, and only the membership read afterwards reveals it. yabai's scripting
/// addition runs inside Dock.app, which holds the privileged connection, so it can move a window it
/// does not own -- the same route ADR-0059 already takes to move third-party windows for the Dock
/// Desktop swap, and the one the composer-sync prototype was validated against.
///
/// Space identity crosses this boundary as the stable SkyLight Space ID, never a Desktop ordinal.
/// yabai's `index` is positional and shifts whenever Desktops are added, removed, or reordered, so it
/// is resolved from a live `query --spaces` immediately before each move and never stored. yabai's
/// `id` IS the SkyLight managed Space ID, which is what makes that join possible at all.
///
/// Membership is verified through SkyLight rather than yabai, because SkyLight is what the desktop
/// audit reads to decide the window's Desktop in the first place. Verifying against a second source
/// could agree while the audit still disagreed, which is the divergence ADR-0092 exists to prevent.
struct YabaiWindowSpaceMover: AgentWindowDesktopMoving {
    private let commandRunner: any YabaiSyncCommandRunning
    private let membership: any WindowSpaceMembershipReading
    private let verifyAttempts: Int
    private let verifyInterval: TimeInterval
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    init(
        commandRunner: any YabaiSyncCommandRunning = YabaiProcessCommandRunner(
            executableURL: Config.yabaiURL,
            timeout: Config.yabaiCommandTimeoutSeconds
        ),
        membership: any WindowSpaceMembershipReading = HostWorkspaceWindowSpaceMover(),
        verifyAttempts: Int = Config.claudeWindowMoveVerifyAttempts,
        verifyInterval: TimeInterval = Config.claudeWindowMoveVerifyInterval
    ) {
        self.commandRunner = commandRunner
        self.membership = membership
        self.verifyAttempts = verifyAttempts
        self.verifyInterval = verifyInterval
    }

    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
        let index = try desktopIndex(ofSpaceID: targetSpaceID)
        _ = try run(["-m", "window", String(windowID), "--space", String(index)])
        try verify(windowID: windowID, targetSpaceID: targetSpaceID)
    }

    /// yabai's positional Desktop number for a stable Space ID, read fresh for this move.
    private func desktopIndex(ofSpaceID spaceID: UInt64) throws -> Int {
        let spaces: [YabaiSpaceRow] = try decode(run(["-m", "query", "--spaces"]))
        guard let space = spaces.first(where: { $0.id == spaceID }) else {
            logger.error("composer move has no Desktop for Space \(spaceID, privacy: .public)")
            throw AgentWindowInputReason.moveFailed
        }
        return space.index
    }

    /// The move is fire-and-verify: yabai reports its own exit status, not whether WindowServer agreed.
    ///
    /// A yabai without its scripting addition exits zero and moves nothing, which is exactly the silent
    /// no-op this type exists to replace, so the membership read is the only real confirmation.
    private func verify(windowID: UInt32, targetSpaceID: UInt64) throws {
        var observed: [UInt64] = []
        for attempt in 0..<max(1, verifyAttempts) {
            observed = (try? membership.spaceIDs(for: windowID)) ?? []
            if observed == [targetSpaceID] { return }
            if attempt + 1 < verifyAttempts, verifyInterval > 0 {
                Thread.sleep(forTimeInterval: verifyInterval)
            }
        }
        logger.error(
            """
            composer move unverified window=\(windowID, privacy: .public) \
            targetSpace=\(targetSpaceID, privacy: .public) observed=\(observed, privacy: .public)
            """
        )
        throw AgentWindowInputReason.moveFailed
    }

    private func run(_ arguments: [String]) throws -> Data {
        do {
            return try commandRunner.runNow(arguments: arguments)
        } catch YabaiCommandError.executableUnavailable(let path) {
            // yabai is separately installed and separately Accessibility-authorized. Absent, the
            // composer cannot reach an off-Desktop window at all, and saying so beats reporting a move
            // that was never attempted as a move that failed.
            logger.error("composer move needs yabai, missing at \(path, privacy: .public)")
            throw AgentWindowInputReason.windowMoverUnavailable
        } catch YabaiCommandError.launchFailed(let message) {
            logger.error("composer move could not start yabai: \(message, privacy: .public)")
            throw AgentWindowInputReason.windowMoverUnavailable
        } catch {
            logger.error(
                """
                composer move command failed args=\(arguments.joined(separator: " "), privacy: .public) \
                error=\(String(describing: error), privacy: .public)
                """
            )
            throw AgentWindowInputReason.moveFailed
        }
    }

    private func decode<Value: Decodable>(_ data: Data) throws -> Value {
        do {
            return try JSONDecoder().decode(Value.self, from: data)
        } catch {
            logger.error("composer move got undecodable yabai output: \(String(describing: error), privacy: .public)")
            throw AgentWindowInputReason.moveFailed
        }
    }
}

/// One Desktop as yabai reports it: the stable SkyLight Space ID plus the positional number yabai
/// commands take.
private struct YabaiSpaceRow: Decodable, Sendable {
    let id: UInt64
    let index: Int
}
