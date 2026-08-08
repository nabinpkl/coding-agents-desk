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
    func awaitComposer(frame: CGRect, mainPid: pid_t) throws
    func readComposer(frame: CGRect, mainPid: pid_t) throws -> String
    /// The composer element when the scan is free, nil when the window or its tree is unavailable.
    /// Non-throwing on purpose: observer registration is opportunistic.
    func composerElementIfAvailable(frame: CGRect, mainPid: pid_t) -> AXUIElement?
    /// Writes the composer and returns what it reads back. Never sends Return.
    func writeComposer(_ text: String, frame: CGRect, mainPid: pid_t) throws -> String
    /// Focuses the composer and presses Return, committing whatever it holds. Returns the composer
    /// value read after the send (expected to be the cleared field). Deliberately activates the window.
    func submitComposer(frame: CGRect, mainPid: pid_t) throws -> String
}

/// Fills a Codex Desktop window's composer for one thread, without activating it and without sending.
///
/// Unlike the Claude writer, the codex composer needs no `AXManualAccessibility` latch and no Space
/// round trip for the common case: the app materializes full trees for every window on every Desktop
/// (probed live), so reads and writes are free. A window whose tree is missing entirely -- the
/// materialization case -- pays one bring-to-this-Desktop / await / act / restore round trip, because
/// a moved window is a visible flash and should not happen on every write.
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
                return .success(try access.readComposer(frame: target.frame, mainPid: target.claudeMainPid))
            } catch AgentWindowInputReason.composerMissing {
                return recover(target) { try access.readComposer(frame: target.frame, mainPid: target.claudeMainPid) }
            } catch let reason as AgentWindowInputReason {
                return .failure(reason)
            } catch {
                return .failure(.writeFailed)
            }
        }
    }

    /// The composer element when it costs nothing to find, for observer registration.
    func composerElementIfAvailable(for target: AgentWindowSessionTarget) -> AXUIElement? {
        access.composerElementIfAvailable(frame: target.frame, mainPid: target.claudeMainPid)
    }

    /// Fills the composer, returning the text the window reads back.
    func write(_ text: String, to target: AgentWindowSessionTarget) -> Result<String, AgentWindowInputReason> {
        withFrontmostGuard(target: target) {
            let result: Result<String, AgentWindowInputReason>
            do {
                result = .success(try access.writeComposer(text, frame: target.frame, mainPid: target.claudeMainPid))
            } catch AgentWindowInputReason.composerMissing {
                result = recover(target) { try access.writeComposer(text, frame: target.frame, mainPid: target.claudeMainPid) }
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
            _ = try access.writeComposer(text, frame: target.frame, mainPid: target.claudeMainPid)
            result = .success(try access.submitComposer(frame: target.frame, mainPid: target.claudeMainPid))
        } catch AgentWindowInputReason.composerMissing {
            result = recover(target) {
                _ = try access.writeComposer(text, frame: target.frame, mainPid: target.claudeMainPid)
                return try access.submitComposer(frame: target.frame, mainPid: target.claudeMainPid)
            }
        } catch let reason as AgentWindowInputReason {
            result = .failure(reason)
        } catch {
            result = .failure(.writeFailed)
        }
        return result
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
            try access.awaitComposer(frame: target.frame, mainPid: target.claudeMainPid)
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
