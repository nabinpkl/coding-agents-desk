// The verb table for the composer half of `--control`.
//
// Kept apart from `ControlMode.swift` so the transport (framing, correlation, idle watchdog) and the
// capability surface grow independently. Every verb here is a thin adapter: decode the target the
// sidecar resolved, call one AX or SkyLight operation, hand back a JSON body or a reason code.
//
// No verb makes a decision. There is no retry, no fallback to a different window, no "if the
// composer is missing, restart the renderer" -- the sidecar owns all of that, because those are the
// choices that get revised, and revising them here would cost an app-adjacent rebuild for something
// that is not a native capability at all. Timeouts are PASSED IN for the same reason: the loops run
// natively because they are tight AX polls, but the numbers stay in `config.ts`.

import CoreGraphics
import Foundation

func registerComposerVerbs(on control: ControlMode) {
    let observer = ComposerObserver { control.push($0) }
    let workspace = WorkspaceObserver { control.push($0) }

    /// Decodes the target and runs `body`, turning a `ComposerFailure` into its reason code.
    ///
    /// A missing or malformed target is `no-window` rather than a generic error: the sidecar resolves
    /// the target immediately before sending, so the only way to arrive here without one is a
    /// resolution that produced nothing, and that is exactly what `no-window` names.
    func targeted(
        _ request: [String: Any],
        _ body: (ComposerTarget) throws -> [String: Any]
    ) -> ControlMode.Outcome {
        guard let target = ComposerTarget(request) else { return .failure("no-window") }
        do {
            return .ok(try body(target))
        } catch let failure as ComposerFailure {
            return .failure(failure.reason)
        } catch {
            return .failure("write-failed")
        }
    }

    func milliseconds(_ request: [String: Any], _ key: String, _ fallback: Int) -> Int {
        guard let value = (request[key] as? NSNumber)?.intValue, value > 0, value <= 120_000 else {
            return fallback
        }
        return value
    }

    control.register("composer-read") { request in
        targeted(request) { ["text": try ComposerAccess.readComposer($0)] }
    }

    control.register("composer-write") { request in
        guard let text = request["text"] as? String else { return .failure("write-failed") }
        return targeted(request) { target in
            [
                "text": try ComposerAccess.writeComposer(
                    target,
                    text: text,
                    settleMs: milliseconds(request, "settleMs", 2_000),
                    pollMs: milliseconds(request, "pollMs", 100)
                ),
            ]
        }
    }

    control.register("composer-submit") { request in
        targeted(request) { target in
            [
                "text": try ComposerAccess.submitComposer(
                    target,
                    settleMs: milliseconds(request, "settleMs", 2_000),
                    pollMs: milliseconds(request, "pollMs", 100)
                ),
            ]
        }
    }

    control.register("composer-await") { request in
        targeted(request) { target in
            try ComposerAccess.awaitComposer(
                target,
                timeoutMs: milliseconds(request, "timeoutMs", 20_000),
                pollMs: milliseconds(request, "pollMs", 200)
            )
            return [:]
        }
    }

    /// Node and text-area counts for a window whose composer was not found. Read-only, and asked for
    /// only after a failure, so its cost never lands on the healthy path.
    control.register("composer-census") { request in
        targeted(request) { ComposerAccess.treeCensus($0) }
    }

    control.register("composer-observe") { request in
        targeted(request) { target in
            try observer.observe(target)
            return ["observing": true]
        }
    }

    control.register("composer-unobserve") { request in
        guard let pid = (request["claudeMainPid"] as? NSNumber)?.int32Value else {
            return .failure("no-window")
        }
        observer.stopObserving(pid: pid)
        return .ok(["observing": false])
    }

    control.register("composer-unobserve-all") { _ in
        observer.stopAll()
        return .ok([:])
    }

    control.register("ax-latch") { request in
        guard let pid = (request["claudeMainPid"] as? NSNumber)?.int32Value else {
            return .failure("no-window")
        }
        do {
            try ComposerAccess.latchManualAccessibility(pid: pid)
            return .ok([:])
        } catch let failure as ComposerFailure {
            return .failure(failure.reason)
        } catch {
            return .failure("ax-denied")
        }
    }

    /// The frontmost application's pid.
    ///
    /// Sampled by the sidecar before and after a non-activating write. Nothing in the fill path
    /// activates an application, so a change across it means an assumption broke; it cannot be undone,
    /// only reported.
    control.register("frontmost-pid") { _ in
        .ok(["pid": ComposerAccess.frontmostApplicationPID().map(Int.init) as Any])
    }

    control.register("question-read") { request in
        targeted(request) { try ComposerAccess.readQuestionState($0) }
    }

    control.register("question-action") { request in
        guard let kind = request["action"] as? String else { return .failure("question-missing") }
        return targeted(request) { target in
            switch kind {
            case "select":
                guard let index = (request["option"] as? NSNumber)?.intValue else {
                    throw ComposerFailure.questionMissing
                }
                try ComposerAccess.selectQuestionOption(
                    target,
                    index: index,
                    desired: request["desired"] as? Bool ?? true
                )
            case "other":
                guard let text = request["text"] as? String else { throw ComposerFailure.questionMissing }
                try ComposerAccess.setQuestionOther(target, text: text)
            default:
                try ComposerAccess.pressQuestionButton(target, kind: kind)
            }
            // The panel's state after the action, in the same round trip. A press changes what the
            // viewer should see, and a second request to find out would render one stale frame every
            // time.
            return try ComposerAccess.readQuestionState(target)
        }
    }

    /// Brings a window to a Desktop, or puts it back.
    ///
    /// One verb for both directions: it is the same operation, and the sidecar owns the sequence
    /// (move in, act, move back) because that ordering is policy and has already changed once.
    control.register("window-move") { request in
        guard let windowID = (request["windowID"] as? NSNumber)?.uint32Value,
              let raw = request["spaceID"] as? String,
              let spaceID = UInt64(raw)
        else { return .failure("move-failed") }
        do {
            try WindowSpaceMover.move(
                windowID: windowID,
                toSpaceID: spaceID,
                verifyAttempts: min(max((request["verifyAttempts"] as? NSNumber)?.intValue ?? 4, 1), 50),
                verifyIntervalMs: milliseconds(request, "verifyIntervalMs", 50)
            )
            return .ok([:])
        } catch let failure as ComposerFailure {
            return .failure(failure.reason)
        } catch {
            return .failure("move-failed")
        }
    }

    /// Starts and stops the window-system notifications.
    ///
    /// Separate from `composer-observe` because they are not per-pid: an application LAUNCHING is
    /// exactly the event nobody has a pid for yet, so the sidecar turns this on once while it has
    /// any watched session and off when it has none.
    control.register("workspace-observe") { _ in
        workspace.start()
        return .ok(["observing": true])
    }

    control.register("workspace-unobserve") { _ in
        workspace.stop()
        return .ok(["observing": false])
    }

    control.register("window-mover-available") { _ in
        .ok(["available": WindowSpaceMover.isAvailable])
    }

    registerCodexVerbs(on: control)
}

/// Codex Desktop's verbs.
///
/// Separate from Claude's because the two are not the same problem behind the same names: Codex
/// windows are addressed by WindowServer id rather than by pid, identity comes out of the
/// accessibility tree rather than the process tree, and reaching an off-Desktop window at all
/// depends on a handle captured earlier. Only the composer read/write/submit shapes rhyme.
private func registerCodexVerbs(on control: ControlMode) {
    let codex = CodexAccess.shared

    func windowed(
        _ request: [String: Any],
        _ body: (CGWindowID, pid_t) throws -> [String: Any]
    ) -> ControlMode.Outcome {
        guard let windowID = (request["windowID"] as? NSNumber)?.uint32Value,
              let mainPid = (request["mainPid"] as? NSNumber)?.int32Value
        else { return .failure("no-window") }
        do {
            return .ok(try body(windowID, mainPid))
        } catch let failure as ComposerFailure {
            return .failure(failure.reason)
        } catch {
            return .failure("write-failed")
        }
    }

    func milliseconds(_ request: [String: Any], _ key: String, _ fallback: Int) -> Int {
        guard let value = (request[key] as? NSNumber)?.intValue, value > 0, value <= 120_000 else {
            return fallback
        }
        return value
    }

    /// Identity of every Codex window, for the sidecar to match threads against.
    control.register("codex-window-summaries") { request in
        guard let mainPid = (request["mainPid"] as? NSNumber)?.int32Value else {
            return .failure("no-window")
        }
        do {
            return .ok(["windows": try codex.windowSummaries(mainPid: mainPid)])
        } catch let failure as ComposerFailure {
            return .failure(failure.reason)
        } catch {
            return .failure("no-window")
        }
    }

    /// Takes a handle on every window the app currently lists.
    ///
    /// The sidecar calls this while the windows are on the active Desktop, which is the only moment
    /// the app admits to them, and it is what makes an off-Desktop Codex window addressable later.
    control.register("codex-capture-windows") { request in
        guard let mainPid = (request["mainPid"] as? NSNumber)?.int32Value else {
            return .failure("no-window")
        }
        codex.captureWindows(mainPid: mainPid)
        return .ok([:])
    }

    control.register("codex-forget-windows") { request in
        let live = (request["windowIDs"] as? [NSNumber])?.map(\.uint32Value) ?? []
        codex.forgetWindows(keeping: Set(live))
        return .ok([:])
    }

    control.register("codex-holds-window") { request in
        guard let windowID = (request["windowID"] as? NSNumber)?.uint32Value else {
            return .failure("no-window")
        }
        return .ok(["held": codex.holdsWindow(windowID)])
    }

    control.register("codex-composer-read") { request in
        windowed(request) { ["text": try codex.readComposer(windowID: $0, mainPid: $1)] }
    }

    control.register("codex-composer-write") { request in
        guard let text = request["text"] as? String else { return .failure("write-failed") }
        return windowed(request) { windowID, mainPid in
            [
                "text": try codex.writeComposer(
                    text,
                    windowID: windowID,
                    mainPid: mainPid,
                    settleMs: milliseconds(request, "settleMs", 2_000),
                    pollMs: milliseconds(request, "pollMs", 100)
                ),
            ]
        }
    }

    control.register("codex-composer-submit") { request in
        windowed(request) { windowID, mainPid in
            [
                "text": try codex.submitComposer(
                    windowID: windowID,
                    mainPid: mainPid,
                    settleMs: milliseconds(request, "settleMs", 2_000),
                    pollMs: milliseconds(request, "pollMs", 100)
                ),
            ]
        }
    }

    control.register("codex-composer-await") { request in
        windowed(request) { windowID, mainPid in
            try codex.awaitComposer(
                windowID: windowID,
                mainPid: mainPid,
                timeoutMs: milliseconds(request, "timeoutMs", 20_000),
                pollMs: milliseconds(request, "pollMs", 200)
            )
            return [:]
        }
    }
}
