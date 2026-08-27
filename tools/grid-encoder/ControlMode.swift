// `grid-encoder --control`: the helper with no capture.
//
// Same binary, same stdin NDJSON channel, same `.control` stdout frame as desktop-control-v2. What
// is missing is ScreenCaptureKit, the encoder, and the cursor mirror, because the composer path
// needs none of them -- it needs Accessibility, the `AXManualAccessibility` latch, and SkyLight,
// and those three are the entire reason any of this is still Swift.
//
// It stays RESIDENT rather than running one verb and exiting. An `AXObserver` only delivers while
// its own process runs a run loop (`ComposerObserver.swift` adds its source to the main one), so a
// one-shot-per-request helper would silently downgrade composer sync from event-driven back to
// polling. `dispatchMain()` at the end of `main.swift` is that run loop.
//
// Resident processes need a way to die, and this one cannot rely on being killed. `bun --watch`
// reloads the sidecar's module graph IN THE SAME PID, so a helper spawned before a reload is
// referenced by nothing afterwards and no code path will ever call `kill()` on it. The pool that
// spawns encoders learned the same lesson from the other direction and stopped waiting to be told a
// reader had gone. So: no command for `idleSeconds` and this process ends itself. An orphan
// receives nothing by definition, and a live one is spoken to several times a second.

import AppKit
import ApplicationServices
import Foundation

/// Builds the verb table and hands the process to the run loop. Never returns.
///
/// Called from `main.swift` before the capture path so the two modes never share setup: a control
/// helper that had opened an `SCStream` would be holding a capture nobody reads, which is the exact
/// condition the encoder's stdout watchdog exists to kill.
func runControlMode(
    idleSeconds: Double,
    emitMeta: @escaping ([String: Any]) -> Void,
    emitControl: @escaping (Data) -> Void
) -> Never {
    // NSWorkspace, which the frontmost-application check reads, wants an initialized app object
    // even in a binary with no bundle and no UI.
    _ = NSApplication.shared

    let control = ControlMode(idleSeconds: idleSeconds, emitControl: emitControl)

    // `AXIsProcessTrusted()` directly rather than through `DesktopInputController`: control mode
    // posts no events, so building an input controller around a zero rect and an unused
    // `CGEventSource` for one boolean would imply a capability this mode does not have.
    control.register("ax-ping") { _ in
        .ok([
            "inputTrusted": AXIsProcessTrusted(),
            "screenRecordingTrusted": DesktopAudit.screenRecordingTrusted,
        ])
    }
    control.register("desktop-audit") { _ in .ok(DesktopAudit.snapshot()) }
    registerComposerVerbs(on: control)

    // Announced before the loop starts so the sidecar can refuse a helper that came up without the
    // grants instead of discovering it one failed composer read at a time. `inputTrusted` false is
    // not fatal here -- a read-only audit still works -- so this reports rather than exits, and the
    // sidecar decides which verbs it is willing to call.
    emitMeta([
        "type": "open",
        "mode": "control",
        "inputTrusted": AXIsProcessTrusted(),
        "screenRecordingTrusted": DesktopAudit.screenRecordingTrusted,
        "composerVersion": 1,
    ])

    control.start()
    // The AX observers registered in S3 deliver on this run loop. Without it the process would exit
    // as soon as the command thread was detached.
    dispatchMain()
}

/// One request/response channel over stdin/stdout, plus the idle watchdog.
///
/// Verbs are registered rather than switched inline so the AX surface can grow without this file
/// growing with it: `main.swift` builds the table, this owns the transport.
final class ControlMode {
    /// What a verb returns. `.ok` carries the JSON body; `.failure` carries a `WindowInputReason`
    /// string from `agent-feed/wire/desktopWindow.ts`, never a free-text message, because the panel
    /// maps the code to a sentence and an unmapped code degrades to "unavailable, reason unknown".
    enum Outcome {
        case ok([String: Any])
        case failure(String)
    }

    typealias Verb = (_ request: [String: Any]) -> Outcome

    private let emitControl: (Data) -> Void
    private let idleSeconds: Double
    private var verbs: [String: Verb] = [:]
    private let lastCommandLock = NSLock()
    private var lastCommandAt = Date()

    /// Larger than a desktop-control message because a composer write carries the composer's whole
    /// text, and a long prompt is the normal case rather than an attack. Still bounded: the buffer
    /// is dropped and the sender told, exactly as the input path does.
    static let maximumCommandBytes = 512 * 1024

    init(idleSeconds: Double, emitControl: @escaping (Data) -> Void) {
        self.idleSeconds = idleSeconds
        self.emitControl = emitControl
    }

    func register(_ name: String, _ verb: @escaping Verb) {
        verbs[name] = verb
    }

    /// Pushes an unsolicited event (an observer notification, not a reply). No `rid`: the sidecar
    /// routes these by type, and inventing a correlation id for something nobody asked for would
    /// make a reply and a notification indistinguishable at the other end.
    func push(_ event: [String: Any]) {
        emit(event)
    }

    func start() {
        startIdleWatchdog()
        startCommandLoop()
    }

    // MARK: - Transport

    private func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        emitControl(data)
    }

    private func startCommandLoop() {
        Thread.detachNewThread { [self] in
            var buffer = Data()
            while true {
                // `availableData` rather than `read(upToCount:)` for the same reason the encoder's
                // loop uses it: the fixed-size read waits for a full buffer and holds a lone
                // command until enough later ones arrive to fill it.
                let data = FileHandle.standardInput.availableData
                guard !data.isEmpty else {
                    // Stdin EOF. The parent is gone or dropped the handle, so there is nobody left
                    // to answer and nothing to hold an observer for.
                    exit(0)
                }
                buffer.append(data)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let raw = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
                    buffer.removeSubrange(buffer.startIndex...newline)
                    handle(raw.last == "\r" ? String(raw.dropLast()) : raw)
                }
                if buffer.count > Self.maximumCommandBytes {
                    buffer.removeAll(keepingCapacity: true)
                    emit(["type": "error", "reason": "command-too-large"])
                }
            }
        }
    }

    private func handle(_ line: String) {
        touch()
        guard !line.isEmpty else { return }
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            emit(["type": "error", "reason": "malformed-json"])
            return
        }
        // The `rid` is echoed on every reply including the failures, because a request that dies
        // without one leaves the sidecar's correlation table waiting for a timeout instead of
        // failing immediately with the reason.
        let rid = object["rid"] as? String
        guard let name = object["type"] as? String else {
            reply(rid: rid, .failure("malformed-request"))
            return
        }
        guard let verb = verbs[name] else {
            reply(rid: rid, .failure("unknown-verb"))
            return
        }
        reply(rid: rid, verb(object))
    }

    private func reply(rid: String?, _ outcome: Outcome) {
        var message: [String: Any] = ["type": "result"]
        if let rid { message["rid"] = rid }
        switch outcome {
        case .ok(let body):
            message["ok"] = true
            message["value"] = body
        case .failure(let reason):
            message["ok"] = false
            message["reason"] = reason
        }
        emit(message)
    }

    // MARK: - Idle watchdog

    private func touch() {
        lastCommandLock.lock()
        lastCommandAt = Date()
        lastCommandLock.unlock()
    }

    private func startIdleWatchdog() {
        guard idleSeconds > 0 else { return }
        Thread.detachNewThread { [self] in
            while true {
                Thread.sleep(forTimeInterval: 1)
                lastCommandLock.lock()
                let last = lastCommandAt
                lastCommandLock.unlock()
                if Date().timeIntervalSince(last) > idleSeconds { exit(0) }
            }
        }
    }
}
