// The event-driven half of composer sync.
//
// Instead of polling a composer's value, an `AXObserver` is registered for `kAXValueChanged` on the
// composer element and the sidecar is told exactly when the value moved. The poll still exists in
// the sidecar for resolution -- windows open and close and that is not an AX event -- but a watched
// session's TEXT is event-driven, which is the difference between reading a whole Chromium subtree
// several times a second and reading it when a human types.
//
// This is the reason `--control` is a resident process rather than one spawn per verb.
// `AXObserverGetRunLoopSource` delivers on the run loop of the process that created it, so a helper
// that exited after answering would never fire a single notification. `runControlMode` ends in
// `CFRunLoopRun()` for exactly this -- and specifically NOT in `dispatchMain()`, which parks the
// main thread without running a run loop and delivers none of these.
//
// One observer per owning pid, not per session: a Claude Desktop instance is one AX application, and
// registering twice on the same element delivers twice.

import ApplicationServices
import Foundation

final class ComposerObserver {
    /// Pushed to the sidecar when a watched composer's value changes. Carries the pid only: the
    /// sidecar knows which sessions map to it and re-reads the ones it is watching, which keeps the
    /// mapping in the half that can change without a rebuild.
    private let emit: ([String: Any]) -> Void
    private var observations: [pid_t: Observation] = [:]
    private let lock = NSLock()

    private final class Observation {
        let observer: AXObserver
        let element: AXUIElement
        /// The application element, carrying the create/destroy notifications. Separate from
        /// `element` because those fire for the whole tree, not for one field.
        let application: AXUIElement
        let source: CFRunLoopSource
        /// Owns the retained `Unmanaged` box the C callback receives as its refcon.
        let box: Unmanaged<HandlerBox>
        /// The application-level box, retained for as long as its notifications are registered.
        let applicationBox: Unmanaged<HandlerBox>?

        init(
            observer: AXObserver,
            element: AXUIElement,
            application: AXUIElement,
            source: CFRunLoopSource,
            box: Unmanaged<HandlerBox>,
            applicationBox: Unmanaged<HandlerBox>?
        ) {
            self.observer = observer
            self.element = element
            self.application = application
            self.source = source
            self.box = box
            self.applicationBox = applicationBox
        }
    }

    /// A class wrapper so a Swift closure can survive the trip through a C function pointer's
    /// `refcon`. `AXObserverCreate`'s callback is `@convention(c)` and cannot capture.
    final class HandlerBox {
        let handler: () -> Void
        init(handler: @escaping () -> Void) {
            self.handler = handler
        }
    }

    init(emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
    }

    /// Whether a pid is currently observed. The sidecar skips value reads on its poll pass while this
    /// is true: the events carry the changes, so the poll would be redundant AX traffic.
    func isObserving(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return observations[pid] != nil
    }

    var observedPids: [pid_t] {
        lock.lock()
        defer { lock.unlock() }
        return Array(observations.keys)
    }

    /// Registers on the target's composer. Idempotent per pid: a second watcher of the same instance
    /// joins the existing observation rather than creating a second one.
    ///
    /// Runs the registration on the main run loop, because that is the loop the source is added to
    /// and `CFRunLoopAddSource` from another thread would attach to a loop nothing is running.
    func observe(_ target: ComposerTarget) throws {
        lock.lock()
        let existing = observations[target.claudeMainPid] != nil
        lock.unlock()
        if existing { return }

        let composer = try ComposerAccess.composerElement(target)
        let pid = target.claudeMainPid

        var observerRef: AXObserver?
        guard AXObserverCreate(pid, Self.callback, &observerRef) == .success, let observer = observerRef
        else { throw ComposerFailure.accessibilityDenied }

        let box = Unmanaged.passRetained(HandlerBox { [weak self] in
            self?.emit(["type": "composer-changed", "pid": Int(pid)])
        })
        let added = AXObserverAddNotification(
            observer,
            composer,
            kAXValueChangedNotification as CFString,
            box.toOpaque()
        )
        guard added == .success else {
            box.release()
            throw ComposerFailure.accessibilityDenied
        }

        // The AskUserQuestion panel appearing and disappearing is a tree change, not a value
        // change, so it rides the APPLICATION element rather than the composer. Its absence is why
        // the panel's live state was read on a timer; with this the sidecar is told, and asks once.
        //
        // Best-effort: a build that refuses these notifications still gets composer text events,
        // and the sidecar's backstop still reports the question eventually. Losing the whole
        // observation over the optional half would be the worse trade.
        let application = AXUIElementCreateApplication(pid)
        var applicationBox: Unmanaged<HandlerBox>? = Unmanaged.passRetained(HandlerBox { [weak self] in
            self?.emit(["type": "question-changed", "pid": Int(pid)])
        })
        for notification in [kAXCreatedNotification, kAXUIElementDestroyedNotification] {
            guard let boxed = applicationBox else { break }
            if AXObserverAddNotification(
                observer,
                application,
                notification as CFString,
                boxed.toOpaque()
            ) != .success {
                boxed.release()
                applicationBox = nil
            }
        }

        let source = AXObserverGetRunLoopSource(observer)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        lock.lock()
        observations[pid] = Observation(
            observer: observer,
            element: composer,
            application: application,
            source: source,
            box: box,
            applicationBox: applicationBox
        )
        lock.unlock()
    }

    /// Stops observing a pid. Called when the last watcher of every session in that instance goes
    /// away: keeping Chromium's observer alive is exactly the continuous traffic that focus gating
    /// exists to save.
    func stopObserving(pid: pid_t) {
        lock.lock()
        let observation = observations.removeValue(forKey: pid)
        lock.unlock()
        guard let observation else { return }
        AXObserverRemoveNotification(
            observation.observer,
            observation.element,
            kAXValueChangedNotification as CFString
        )
        if let applicationBox = observation.applicationBox {
            for notification in [kAXCreatedNotification, kAXUIElementDestroyedNotification] {
                AXObserverRemoveNotification(
                    observation.observer,
                    observation.application,
                    notification as CFString
                )
            }
            applicationBox.release()
        }
        CFRunLoopSourceInvalidate(observation.source)
        observation.box.release()
    }

    func stopAll() {
        for pid in observedPids { stopObserving(pid: pid) }
    }

    private static let callback: @convention(c) (
        AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?
    ) -> Void = { _, _, _, refcon in
        guard let refcon else { return }
        Unmanaged<HandlerBox>.fromOpaque(refcon).takeUnretainedValue().handler()
    }
}
