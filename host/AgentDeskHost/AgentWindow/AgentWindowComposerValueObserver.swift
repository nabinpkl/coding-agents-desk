import ApplicationServices
import Foundation

/// The seam that delivers Claude composer value-changed events to the coordinator.
///
/// The event-driven half of composer sync: instead of polling the composer's value, the host registers
/// an `AXObserver` for `kAXValueChanged` on the composer element and is told exactly when the value
/// changes. Chromium posts the notification for web contents value changes -- validated live against
/// Claude Desktop: setting `AXValue` fired the notification with the new value, and so did the restore,
/// so both our own write echoes and independent Claude-side edits arrive the same way.
protocol AgentWindowComposerValueObserving {
    /// Ensures the target's Claude process is observed for composer value changes.
    ///
    /// Registers the given composer element with the process's observer; a second window of the same
    /// Claude process (a second coding session) adds its own element to the same observer. `composer`
    /// is the element found by the most recent successful scan. Deliveries hop to the queue the caller
    /// chose by whatever `onValueChanged` does; the observer itself delivers on the main run loop.
    func ensureObserving(
        target: AgentWindowSessionTarget,
        composer: AXUIElement,
        onValueChanged: @escaping @Sendable () -> Void
    )

    /// Drops the observer for the process. Safe when none is registered.
    func stopObserving(claudeMainPid: pid_t)

    /// Whether the process is currently observed. The coordinator skips value reads on its poll pass
    /// while this is true: the events carry the changes, so the poll would be redundant AX traffic.
    func isObserving(claudeMainPid: pid_t) -> Bool

    /// Every currently observed process, ascending.
    var observedPids: [pid_t] { get }
}

/// The live Accessibility implementation of a value-changed observer for composer elements.
///
/// One `AXObserver` per owning pid (a Claude Desktop instance, or the ChatGPT.app process hosting
/// Codex Desktop), with one `kAXValueChanged` registration per composer element found for that
/// process -- one pid can hold several session windows, and each element gets its own handler box so
/// its changes reach the session that owns it. Registration touches
/// only elements the scanner already found, so it never activates or focuses anything. Delivery runs
/// on the main run loop -- the host is an AppKit application -- and each callback forwards through the
/// handler the coordinator registered, which is the coordinator's serial queue hop.
///
/// The refcon boxes are retained at registration and intentionally never released: a callback can be
/// in flight while `stopObserving` runs, and a freed box would be a use-after-free. Each box is a few
/// dozen bytes and there is one per Claude process per observation cycle, so the leak is bounded and
/// negligible; the alternative is a lock-and-lifetime protocol around a C callback that is not worth
/// the machinery.
final class AgentWindowComposerValueObserver: AgentWindowComposerValueObserving {
    private final class HandlerBox: @unchecked Sendable {
        let lock = NSLock()
        var handler: (@Sendable () -> Void)?

        func fire() {
            lock.lock()
            handler?()
            lock.unlock()
        }
    }

    private struct Observation {
        let observer: AXObserver
        let source: CFRunLoopSource
        /// One retained box PER registered element: the C callback's refcon is per registration, and
        /// each element's events must reach the handler of the SESSION that owns that element. A
        /// single shared box would deliver a second window's changes under the first session's id --
        /// harmless when one pid holds one window, wrong when one pid (Codex Desktop) holds several.
        var elements: [(hash: CFHashCode, element: AXUIElement, box: Unmanaged<HandlerBox>)]
    }

    private let lock = NSLock()
    private var observations: [pid_t: Observation] = [:]

    var observedPids: [pid_t] {
        lock.lock()
        defer { lock.unlock() }
        return observations.keys.sorted()
    }

    func isObserving(claudeMainPid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return observations[claudeMainPid] != nil
    }

    func ensureObserving(
        target: AgentWindowSessionTarget,
        composer: AXUIElement,
        onValueChanged: @escaping @Sendable () -> Void
    ) {
        lock.lock()
        if var existing = observations[target.claudeMainPid] {
            // Same window already observed: nothing to do. A NEW window of the same process: give it
            // its own handler box and register its composer element on the same observer, so its
            // changes arrive under its own session.
            let hash = CFHash(composer)
            if !existing.elements.contains(where: { $0.hash == hash }) {
                let box = HandlerBox()
                box.handler = onValueChanged
                let retainedBox = Unmanaged.passRetained(box)
                AXUIElementSetMessagingTimeout(composer, AgentWindowComposerAccess.messagingTimeout)
                let addResult = AXObserverAddNotification(
                    existing.observer,
                    composer,
                    kAXValueChangedNotification as CFString,
                    Unmanaged.passUnretained(box).toOpaque()
                )
                if addResult == .success {
                    existing.elements.append((hash, composer, retainedBox))
                    observations[target.claudeMainPid] = existing
                } else {
                    retainedBox.release()
                }
            }
            lock.unlock()
            return
        }
        let box = HandlerBox()
        box.handler = onValueChanged
        let retainedBox = Unmanaged.passRetained(box)
        guard let observer = makeObserver(pid: target.claudeMainPid, composer: composer, box: retainedBox) else {
            retainedBox.release()
            lock.unlock()
            return
        }
        observations[target.claudeMainPid] = Observation(
            observer: observer,
            source: AXObserverGetRunLoopSource(observer),
            elements: [(CFHash(composer), composer, retainedBox)]
        )
        lock.unlock()
    }

    func stopObserving(claudeMainPid: pid_t) {
        lock.lock()
        guard let observation = observations.removeValue(forKey: claudeMainPid) else {
            lock.unlock()
            return
        }
        lock.unlock()
        for (_, element, _) in observation.elements {
            AXObserverRemoveNotification(
                observation.observer,
                element,
                kAXValueChangedNotification as CFString
            )
        }
        CFRunLoopSourceInvalidate(observation.source)
        // The boxes are intentionally not released; see the type's documentation.
    }

    private func makeObserver(pid: pid_t, composer: AXUIElement, box: Unmanaged<HandlerBox>) -> AXObserver? {
        AXUIElementSetMessagingTimeout(composer, AgentWindowComposerAccess.messagingTimeout)
        var observerRef: AXObserver?
        guard AXObserverCreate(pid, Self.callback, &observerRef) == .success, let observer = observerRef else {
            return nil
        }
        let addResult = AXObserverAddNotification(
            observer,
            composer,
            kAXValueChangedNotification as CFString,
            Unmanaged.passUnretained(box.takeUnretainedValue()).toOpaque()
        )
        guard addResult == .success else { return nil }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        return observer
    }

    private static let callback: @convention(c) (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?) -> Void = { _, _, _, refcon in
        guard let refcon else { return }
        let box = Unmanaged<HandlerBox>.fromOpaque(refcon).takeUnretainedValue()
        box.fire()
    }
}
