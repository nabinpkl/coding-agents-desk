// The other half of event-driven composer state: what the WINDOW SYSTEM knows.
//
// `ComposerObserver` covers a composer's text. Everything else the sidecar needs -- whether the
// owning application is still running, whether its window is on the Desktop you are looking at --
// was polled, because none of it is an AX value change. Two of those three questions do have OS
// notifications, and this is them.
//
// The third does not, and that is why the sidecar keeps a slow backstop: a session is resolved
// through a `claude --resume <id>` CHILD process, and macOS publishes nothing when an arbitrary
// process starts or exits. Watching that would mean EndpointSecurity, which is its own entitlement
// and its own TCC grant for a question a `/bin/ps` scan answers. So this narrows the poll from
// every few seconds to a backstop; it does not remove it, and the sidecar says so where it lives.
//
// Nothing here filters. The pid and bundle id go up as they arrive and the sidecar decides what
// matters, for the same reason `ComposerObserver` pushes a bare pid: which applications and which
// sessions are interesting is exactly the part that changes without a rebuild.

import AppKit
import Foundation

final class WorkspaceObserver {
    private let emit: ([String: Any]) -> Void
    private var tokens: [NSObjectProtocol] = []
    private let lock = NSLock()

    init(emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
    }

    var isObserving: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !tokens.isEmpty
    }

    /// Starts reporting application launches, terminations, and Desktop switches.
    ///
    /// Idempotent: the sidecar calls this when its first surface starts watching a session, and a
    /// second call must not double every notification.
    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard tokens.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        tokens.append(center.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.emitApplication("launched", note)
        })
        tokens.append(center.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.emitApplication("terminated", note)
        })
        tokens.append(center.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emit(["type": "space-changed"])
        })
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        let center = NSWorkspace.shared.notificationCenter
        for token in tokens { center.removeObserver(token) }
        tokens.removeAll()
    }

    private func emitApplication(_ phase: String, _ note: Notification) {
        let application = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        emit([
            "type": "workspace-changed",
            "phase": phase,
            "pid": application.map { Int($0.processIdentifier) } as Any,
            "bundleID": application?.bundleIdentifier as Any,
        ])
    }
}
