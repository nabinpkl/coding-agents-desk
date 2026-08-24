import AgentDeskWire
import AppKit
import Foundation
import os

/// The Accessibility side of a Codex Desktop composer write, behind a seam.
///
/// Every method here talks to another running application, so none of it is reachable from a test.
/// The seam exists so the sequence around it -- free write, recovery move when the tree is missing,
/// restore, verify -- is, because that ordering is where the failures that matter live.
protocol CodexWindowAccessing {
    /// The process owning the active application, sampled to prove the write did not activate anything.
    func frontmostApplicationPID() -> pid_t?
    /// Blocks until the composer exists in the target window's tree, or fails saying it never did.
    func awaitComposer(windowID: CGWindowID, mainPid: pid_t) throws
    func readComposer(windowID: CGWindowID, mainPid: pid_t) throws -> String
    /// The composer element when the scan is free, nil when the window or its tree is unavailable.
    /// Non-throwing on purpose: observer registration is opportunistic.
    func composerElementIfAvailable(windowID: CGWindowID, mainPid: pid_t) -> AXUIElement?
    /// True when a handle for this window is already held, so the sweep can skip it.
    func holdsWindow(_ windowID: CGWindowID) -> Bool
    /// Captures a handle for every window the app currently lists. Only meaningful while the windows
    /// the caller cares about are on the active Desktop.
    func captureWindows(mainPid: pid_t)
    /// Drops handles for windows that no longer exist.
    func forgetWindows(keeping liveWindowIDs: Set<CGWindowID>)
    /// Writes the composer and returns what it reads back. Never sends Return.
    func writeComposer(_ text: String, windowID: CGWindowID, mainPid: pid_t) throws -> String
    /// Focuses the composer and presses Return, committing whatever it holds. Returns the composer
    /// value read after the send (expected to be the cleared field). Deliberately activates the window.
    func submitComposer(windowID: CGWindowID, mainPid: pid_t) throws -> String
}

/// Fills a Codex Desktop window's composer for one thread, without activating it and without sending.
///
/// Unlike the Claude writer, the codex composer needs no `AXManualAccessibility` latch, and after
/// acquisition it needs no Space round trip either. The two differ because of how the apps are built:
/// Claude Desktop runs one process per window, so a pid names a window and the round trip exists only
/// to make Chromium build the tree. Codex Desktop runs ONE process for every window and will not list
/// the windows that are elsewhere, so a window has to be identified from inside its own tree, and a
/// window elsewhere has no tree to read.
///
/// `acquireWindows` is the answer to that, and the only thing here that moves a window for identity:
/// it brings the unknown windows to this Desktop together, takes a handle for each, and puts them all
/// back. Handles keep working afterwards (measured: twenty seconds of correct reads while the app
/// reported zero windows), so every later read, identity check and write is free. A sweep costs about
/// half a second for two windows and is visible, which is why it runs on thread selection rather than
/// on the resolve poll.
///
/// This never sends Return, and there is no code path that could: the writer sets a text value and
/// reads it back. Committing the prompt stays a human action in the real window.
struct CodexWindowComposerWriter {
    private let access: CodexWindowAccessing
    private let placement: AgentWindowDesktopMoving
    private let logger = Logger(subsystem: Config.logSubsystem, category: "codex-window-composer")

    init(access: CodexWindowAccessing, placement: AgentWindowDesktopMoving) {
        self.access = access
        self.placement = placement
    }

    /// The composer's current text. The codex tree is readable across Desktops, so this is always free.
    func readIfFree(_ target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        read(target)
    }

    /// The composer's current text, paying a recovery round trip only when the window's tree is
    /// missing. For codex this is the same as `readIfFree` plus the recovery move.
    func readAcrossDesktops(_ target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        read(target)
    }

    private func read(_ target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        withFrontmostGuard(target: target) {
            do {
                return .success(try access.readComposer(windowID: target.windowID, mainPid: target.claudeMainPid))
            } catch AgentWindowInputReason.composerMissing {
                return recover(target) { try access.readComposer(windowID: target.windowID, mainPid: target.claudeMainPid) }
            } catch let reason as AgentWindowInputReason {
                return .failure(reason)
            } catch {
                return .failure(.writeFailed)
            }
        }
    }

    /// The composer element when it costs nothing to find, for observer registration.
    func composerElementIfAvailable(for target: AgentWindowSessionTarget) -> AXUIElement? {
        access.composerElementIfAvailable(windowID: target.windowID, mainPid: target.claudeMainPid)
    }

    /// Fills the composer, returning the text the window reads back.
    func write(_ text: String, to target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        withFrontmostGuard(target: target) {
            let result: Result<String, AgentWindowInputReason>
            do {
                result = .success(try access.writeComposer(text, windowID: target.windowID, mainPid: target.claudeMainPid))
            } catch AgentWindowInputReason.composerMissing {
                result = recover(target) { try access.writeComposer(text, windowID: target.windowID, mainPid: target.claudeMainPid) }
            } catch let reason as AgentWindowInputReason {
                result = .failure(reason)
            } catch {
                result = .failure(.writeFailed)
            }
            guard case .success(let readBack) = result else { return result }
            // The web contents can serialize a trailing empty line out of the value; compare the
            // persisted line ends instead of raw strings, exactly like the Claude writer.
            guard AgentWindowComposerWriter.lineEndCanonical(readBack)
                == AgentWindowComposerWriter.lineEndCanonical(text) else {
                return .failure(.verifyMismatch)
            }
            return .success(readBack)
        }
    }

    /// Fills the composer and presses Return, committing the prompt in the owning Codex Desktop window.
    ///
    /// The one deliberate exception to this file's "never sends" rule: the Enter action is the user
    /// asking for the prompt to run, so committing activates (and fronts) the window. No verify
    /// mismatch here -- a committed prompt clears the field, so the empty read-back is the success
    /// signal.
    func writeAndSubmit(_ text: String, to target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        let result: Result<String, AgentWindowInputReason>
        do {
            _ = try access.writeComposer(text, windowID: target.windowID, mainPid: target.claudeMainPid)
            result = .success(try access.submitComposer(windowID: target.windowID, mainPid: target.claudeMainPid))
        } catch AgentWindowInputReason.composerMissing {
            result = recover(target) {
                _ = try access.writeComposer(text, windowID: target.windowID, mainPid: target.claudeMainPid)
                return try access.submitComposer(windowID: target.windowID, mainPid: target.claudeMainPid)
            }
        } catch let reason as AgentWindowInputReason {
            result = .failure(reason)
        } catch {
            result = .failure(.writeFailed)
        }
        return result
    }

    // MARK: - Acquisition

    /// Brings every codex window the host holds no handle for to this Desktop, captures one, and puts
    /// them back. Returns true when a sweep actually happened.
    ///
    /// The restore is unconditional, in a `defer`: a window stranded on the wrong Desktop is a visible
    /// change to the user's workspace and outranks reporting whatever went wrong on the way.
    /// Windows already here are never moved, so a sweep on a Desktop that holds all of them is free
    /// and invisible.
    @discardableResult
    func acquireWindows(mainPid: pid_t, in snapshot: WorkspaceDesktopSnapshot) -> Bool {
        guard let activeSpaceID = snapshot.activeSpaceID, snapshot.diagnostic == nil else { return false }
        let candidates = snapshot.windows.filter {
            $0.ownerPID == mainPid && $0.layer == 0 && $0.spaceIDs.count == 1
        }
        access.forgetWindows(keeping: Set(candidates.map(\.windowID)))
        let missing = candidates.filter { !access.holdsWindow($0.windowID) }
        guard !missing.isEmpty else { return false }

        var relocated: [(windowID: UInt32, homeSpaceID: UInt64)] = []
        defer {
            for window in relocated {
                do {
                    try placement.move(windowID: window.windowID, toSpaceID: window.homeSpaceID)
                } catch {
                    logger.error(
                        "codex acquisition restore failed window=\(window.windowID, privacy: .public) home=\(window.homeSpaceID, privacy: .public) error=\(String(describing: error), privacy: .public)"
                    )
                }
            }
        }
        for window in missing {
            guard let homeSpaceID = window.spaceID, homeSpaceID != activeSpaceID else { continue }
            do {
                try placement.move(windowID: window.windowID, toSpaceID: activeSpaceID)
                relocated.append((window.windowID, homeSpaceID))
            } catch {
                logger.error(
                    "codex acquisition move-in failed window=\(window.windowID, privacy: .public) error=\(String(describing: error), privacy: .public)"
                )
            }
        }
        // The app lists a window a moment after it arrives, so capture until every one asked for is
        // held or the budget runs out. Capturing repeatedly is cheap; the alternative is a fixed sleep
        // that is either too short for a busy renderer or wasted on an idle one.
        let deadline = Date().addingTimeInterval(Config.codexComposerMaterializeTimeout)
        repeat {
            access.captureWindows(mainPid: mainPid)
            if missing.allSatisfy({ access.holdsWindow($0.windowID) }) { break }
            Thread.sleep(forTimeInterval: Config.codexComposerMaterializePollInterval)
        } while Date() < deadline
        let unreachable = missing.filter { !access.holdsWindow($0.windowID) }
        if !unreachable.isEmpty {
            logger.notice(
                "codex acquisition left \(unreachable.count, privacy: .public) window(s) unreachable ids=\(unreachable.map(\.windowID), privacy: .public)"
            )
        }
        return true
    }

    // MARK: - Recovery move

    /// Brings the target window to this Desktop, waits for its tree, runs `body`, and restores the
    /// window before judging the result.
    ///
    /// The codex app builds trees for off-Desktop windows, so this is the recovery path only: a window
    /// whose tree reads as `composerMissing` while the field is plainly there. The materialize wait is
    /// not optional politeness -- the web contents can take a moment to build its tree after the move.
    private func recover<Value>(
        _ target: AgentWindowSessionTarget,
        _ body: () throws -> Value
    ) -> Result<Value, AgentWindowInputReason> {
        do {
            try placement.move(windowID: target.windowID, toSpaceID: target.activeSpaceID)
        } catch {
            logger.error(
                "codex composer move-in failed window=\(target.windowID, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            return .failure(reason(from: error, default: .moveFailed))
        }
        let outcome: Result<Value, AgentWindowInputReason>
        do {
            try access.awaitComposer(windowID: target.windowID, mainPid: target.claudeMainPid)
            outcome = .success(try body())
        } catch let reason as AgentWindowInputReason {
            outcome = .failure(reason)
        } catch {
            outcome = .failure(.writeFailed)
        }
        do {
            try placement.move(windowID: target.windowID, toSpaceID: target.homeSpaceID)
        } catch {
            logger.error(
                "codex composer move-back failed window=\(target.windowID, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            return .failure(reason(from: error, default: .moveFailed))
        }
        return outcome
    }

    /// Asserts the frontmost application is unchanged across a non-activating operation.
    ///
    /// Nothing in the fill or read path activates an application, so a change means an assumption
    /// broke; it cannot be undone, only reported. The submit path is the exception: pressing Return
    /// deliberately fronts the window, so its frontmost change is the requested outcome.
    private func withFrontmostGuard<Value>(
        target: AgentWindowSessionTarget,
        _ body: () -> Result<Value, AgentWindowInputReason>
    ) -> Result<Value, AgentWindowInputReason> {
        let frontmostBefore = access.frontmostApplicationPID()
        let result = body()
        if case .success = result, let frontmostBefore, access.frontmostApplicationPID() != frontmostBefore {
            return .failure(.focusStolen)
        }
        return result
    }

    /// Keeps a mover's own diagnosis when it has one; "the mover is not installed" and "the move did
    /// not take" are different problems with different fixes.
    private func reason(from error: Error, default fallback: AgentWindowInputReason) -> AgentWindowInputReason {
        (error as? AgentWindowInputReason) ?? fallback
    }
}
