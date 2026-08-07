import AgentDeskWire
import Foundation
import os

/// The Accessibility side of a composer write, behind a seam.
///
/// Every method here talks to another running application, so none of it is reachable from a test.
/// The seam exists so the sequence around it -- latch, move in, write, move back, verify -- is, because
/// that ordering is where the failures that matter live: a window stranded on the wrong Desktop, or a
/// write reported as landed when it did not.
protocol AgentWindowComposerAccessing {
    /// The process owning the active application, sampled to prove the write did not activate anything.
    func frontmostApplicationPID() -> pid_t?
    /// Latches Chromium's full accessibility tree on. Write-only and one-way; see the implementation.
    func latchManualAccessibility(pid: pid_t) throws
    /// Blocks until the composer exists in the accessibility tree, or fails saying it never did.
    func awaitComposer(for target: AgentWindowSessionTarget) throws
    func readComposer(for target: AgentWindowSessionTarget) throws -> String
    /// Writes the composer and returns what it reads back. Never sends Return.
    func writeComposer(_ text: String, for target: AgentWindowSessionTarget) throws -> String
    /// Focuses the composer and presses Return, committing whatever it holds. Returns the composer value
    /// read after the send (expected to be the cleared field). Deliberately activates the owning window.
    func submitComposer(for target: AgentWindowSessionTarget) throws -> String
}

/// The Space move a composer write needs. `YabaiWindowSpaceMover` is the real one.
///
/// Deliberately NOT `DesktopWindowPlacementCoordinator`: its SkyLight mover only moves windows this
/// host owns, and Claude's window is another application's.
protocol AgentWindowDesktopMoving {
    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws
}

/// Fills a Claude Desktop window's composer for one session, without activating it and without sending.
///
/// Chromium only builds the accessibility tree for a window on the current Space, so a window living on
/// another Desktop has to be brought here and put back. That round trip is the expensive part of this
/// design and the reason reads are only served when they are free.
///
/// This never sends Return, and there is no code path that could: the writer sets a text value and reads
/// it back. Committing the prompt stays a human action in the real window.
struct AgentWindowComposerWriter {
    private let access: AgentWindowComposerAccessing
    private let placement: AgentWindowDesktopMoving
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    init(access: AgentWindowComposerAccessing, placement: AgentWindowDesktopMoving) {
        self.access = access
        self.placement = placement
    }

    /// The composer's current text, but only when reading it costs nothing.
    ///
    /// A window on another Desktop would have to be dragged onto the user's screen and back to be read,
    /// which is a visible flash. Opening a session row is not worth that, so this returns nil and the
    /// panel offers an explicit load instead.
    func readIfFree(_ target: AgentWindowSessionTarget) -> Result<String?, AgentWindowInputReason> {
        guard target.isOnActiveDesktop else { return .success(nil) }
        do {
            try access.latchManualAccessibility(pid: target.claudeMainPid)
            return .success(try access.readComposer(for: target))
        } catch let reason as AgentWindowInputReason {
            return .failure(reason)
        } catch {
            return .failure(.accessibilityDenied)
        }
    }

    /// The composer's current text, paying a Desktop round trip if the window is elsewhere.
    ///
    /// Only for an explicit user action: unlike `readIfFree`, this will pull another Desktop's window
    /// onto the screen and put it back, which the user sees.
    func readAcrossDesktops(_ target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        withWindowHere(target) { try access.readComposer(for: target) }
    }

    /// Fills the composer, returning the text the window reads back.
    func write(_ text: String, to target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        let result = withWindowHere(target) { try access.writeComposer(text, for: target) }
        guard case .success(let readBack) = result else { return result }
        // ProseMirror serializes a trailing empty final line out of the value, so a draft the user ended
        // with Return does not read back byte for byte. Compare the persisted line ends instead of the
        // raw strings; the check exists to prove the text landed, not that it survived ProseMirror's
        // serialization exactly. Everything but those newlines must still match.
        guard Self.lineEndCanonical(readBack) == Self.lineEndCanonical(text) else {
            return .failure(.verifyMismatch)
        }
        return .success(readBack)
    }

    /// The text with trailing newlines removed, the form ProseMirror read-back collapses them to.
    static func lineEndCanonical(_ text: String) -> String {
        String(text.reversed().drop(while: \.isNewline).reversed())
    }

    /// Fills the composer and presses Return, committing the prompt in the owning Claude Desktop window.
    ///
    /// The one deliberate exception to this file's "never sends" rule: the Enter icon is the user asking
    /// for the prompt to run, so committing activates (and fronts) the window. No verify-mismatch here --
    /// a committed prompt clears the field, so the read-back being empty is the success signal, and any
    /// other observed text is reported as what the window holds rather than judged against what we wrote.
    func writeAndSubmit(_ text: String, to target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        withWindowHere(target, allowsActivation: true) {
            _ = try access.writeComposer(text, for: target)
            return try access.submitComposer(for: target)
        }
    }

    /// Runs `body` with the target window on the active Desktop, then puts the window back.
    ///
    /// Both the write and the explicit read share this because the ordering is the delicate part, not
    /// what happens in the middle: latch, move in, wait for the tree, act, restore before judging the
    /// result, and prove nothing was activated.
    ///
    /// The materialize wait is not optional politeness. Chromium builds a window's accessibility tree
    /// only once that window is on the current Space, so immediately after the move-in the composer
    /// does not exist yet and a write would report the composer missing on a window that is right
    /// there. It is skipped for a window already here, whose tree is already built.
    private func withWindowHere(
        _ target: AgentWindowSessionTarget,
        allowsActivation: Bool = false,
        _ body: () throws -> String
    ) -> Result<String, AgentWindowInputReason> {
        let frontmostBefore = access.frontmostApplicationPID()

        do {
            try access.latchManualAccessibility(pid: target.claudeMainPid)
        } catch let reason as AgentWindowInputReason {
            return .failure(reason)
        } catch {
            return .failure(.accessibilityDenied)
        }

        var moved = false
        if !target.isOnActiveDesktop {
            do {
                try placement.move(windowID: target.windowID, toSpaceID: target.activeSpaceID)
                moved = true
            } catch {
                logger.error(
                    "composer move-in failed window=\(target.windowID, privacy: .public) targetSpace=\(target.activeSpaceID, privacy: .public) error=\(String(describing: error), privacy: .public)"
                )
                return .failure(reason(from: error, default: .moveFailed))
            }
        }

        let outcome: Result<String, AgentWindowInputReason>
        do {
            if moved { try access.awaitComposer(for: target) }
            outcome = .success(try body())
        } catch let reason as AgentWindowInputReason {
            outcome = .failure(reason)
        } catch {
            outcome = .failure(.writeFailed)
        }

        // Put the window back before judging the result. A window left on the wrong Desktop is a visible
        // change to the user's workspace, so restoring it outranks reporting the write, and a failure to
        // restore outranks a failed write in what the panel should say.
        if moved {
            do {
                try placement.move(windowID: target.windowID, toSpaceID: target.homeSpaceID)
            } catch {
                logger.error(
                    "composer move-back failed window=\(target.windowID, privacy: .public) homeSpace=\(target.homeSpaceID, privacy: .public) error=\(String(describing: error), privacy: .public)"
                )
                return .failure(reason(from: error, default: .moveFailed))
            }
        }

        // Sampled after the restore so the whole sequence is covered. Nothing here activates an
        // application, so a change means an assumption broke; it cannot be undone, only reported.
        // The submit path is the exception: pressing Return deliberately fronts the window, so the
        // frontmost change is the requested outcome, not a broken assumption.
        if !allowsActivation, let frontmostBefore, access.frontmostApplicationPID() != frontmostBefore {
            return .failure(.focusStolen)
        }
        return outcome
    }

    /// Keeps a mover's own diagnosis when it has one. "yabai is not installed" and "the move did not
    /// take" are different problems with different fixes, and collapsing both to `moveFailed` would
    /// tell the user to retry something that cannot work.
    private func reason(from error: Error, default fallback: AgentWindowInputReason) -> AgentWindowInputReason {
        (error as? AgentWindowInputReason) ?? fallback
    }
}
