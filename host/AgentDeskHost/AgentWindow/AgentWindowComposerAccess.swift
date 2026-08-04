import AgentDeskWire
import AppKit
import ApplicationServices
import Foundation

/// The live Accessibility implementation of a composer read/write against Claude Desktop.
///
/// Deliberately does nothing that raises, activates, or focuses an application. `AXUIElementSetAttribute`
/// on a value does not require the target to be frontmost, which is the whole reason this approach is
/// viable: the panel can fill a composer on another Desktop without taking the user's screen.
/// Blocks its calling thread for up to `treeRebuildGrace` on first contact with a process, so it must be
/// called off the main thread. `AgentWindowComposerCoordinator` owns that dispatch.
final class AgentWindowComposerAccess: AgentWindowComposerAccessing {
    /// Bounded so an unresponsive renderer cannot stall the caller. Chromium answers AX queries on its
    /// main thread, which a busy session can occupy.
    static let messagingTimeout: Float = 0.5
    /// Depth bound for the composer search. The prompt sits shallow inside the web contents; the bound
    /// is a guard against a cyclic tree, not a real limit.
    static let maxSearchDepth = 48
    /// How long Chromium is given to rebuild its tree after the manual-accessibility latch. Only paid on
    /// the first write to a given process.
    static let treeRebuildGrace: TimeInterval = 1.5

    /// Processes already latched in this host's lifetime. The attribute cannot be read back, so an
    /// in-process record is the only way to know whether the grace period has already been paid.
    private let lock = NSLock()
    private var latchedPIDs: Set<pid_t> = []

    func frontmostApplicationPID() -> pid_t? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    func latchManualAccessibility(pid: pid_t) throws {
        guard AXIsProcessTrusted() else { throw AgentWindowInputReason.accessibilityDenied }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        // Chromium builds its full accessibility tree only once it detects an assistive-technology
        // client; without that, web content collapses to bare AXGroup shells and the composer does not
        // exist to be found. `AXManualAccessibility` is Chromium's private override for that detection.
        // It is write-only and one-way: reading it back always returns false regardless of what was set,
        // and there is no way to turn it off short of relaunching Claude. So this cannot be made
        // conditional on current state, and re-latching on every write is the only available shape.
        let result = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        guard result == .success else { throw AgentWindowInputReason.accessibilityDenied }

        // Chromium rebuilds the tree asynchronously, so the composer does not exist for a moment after
        // the first latch. Waiting is only correct once per process; paying it on every write would make
        // the panel feel broken. Blocking is acceptable because this runs off the main thread.
        lock.lock()
        let alreadyLatched = latchedPIDs.contains(pid)
        latchedPIDs.insert(pid)
        lock.unlock()
        if !alreadyLatched { Thread.sleep(forTimeInterval: Self.treeRebuildGrace) }
    }

    /// Forgets a process, so the next latch pays the rebuild grace again.
    ///
    /// Called when the composer could not be found: either Claude relaunched into a recycled pid and its
    /// new process was never really latched, or the tree was still building. Both are fixed by retrying
    /// as if this process were new, and neither is distinguishable from here.
    func invalidateLatch(pid: pid_t) {
        lock.lock()
        latchedPIDs.remove(pid)
        lock.unlock()
    }

    func readComposer(for target: AgentWindowSessionTarget) throws -> String {
        let composer = try composerElement(for: target)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(composer, kAXValueAttribute as CFString, &value) == .success
        else { throw AgentWindowInputReason.writeFailed }
        return value as? String ?? ""
    }

    func writeComposer(_ text: String, for target: AgentWindowSessionTarget) throws -> String {
        let composer = try composerElement(for: target)
        // Sets the field's value. There is no key synthesis anywhere in this path, so no Return can be
        // produced: the human commits the prompt in the real window.
        let result = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString)
        guard result == .success else { throw AgentWindowInputReason.writeFailed }
        var readBack: CFTypeRef?
        guard AXUIElementCopyAttributeValue(composer, kAXValueAttribute as CFString, &readBack) == .success
        else { throw AgentWindowInputReason.writeFailed }
        return readBack as? String ?? ""
    }

    // MARK: - Element lookup

    private func composerElement(for target: AgentWindowSessionTarget) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw AgentWindowInputReason.accessibilityDenied }
        let app = AXUIElementCreateApplication(target.claudeMainPid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)

        var rawWindows: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows) == .success,
              let windows = rawWindows as? [AXUIElement], !windows.isEmpty
        else { throw AgentWindowInputReason.noWindow }

        guard let window = matchingWindow(target: target, among: windows) else {
            throw AgentWindowInputReason.noWindow
        }
        var visited: Set<UInt> = []
        guard let composer = findComposer(in: window, depth: 0, visited: &visited) else {
            invalidateLatch(pid: target.claudeMainPid)
            throw AgentWindowInputReason.composerMissing
        }
        return composer
    }

    /// Correlates the audited `CGWindowID` to an `AXUIElement`.
    ///
    /// The Accessibility API exposes no window id, so the only shared fact between the two views is the
    /// frame. With a single window there is nothing to disambiguate; with several, an ambiguous frame
    /// match refuses rather than guessing, because the cost of guessing is typing a prompt into the wrong
    /// conversation.
    private func matchingWindow(
        target: AgentWindowSessionTarget,
        among windows: [AXUIElement]
    ) -> AXUIElement? {
        if windows.count == 1 { return windows[0] }
        let matches = windows.filter { window in
            guard let frame = frame(of: window) else { return false }
            return abs(frame.origin.x - target.frame.origin.x) < 2
                && abs(frame.origin.y - target.frame.origin.y) < 2
                && abs(frame.size.width - target.frame.size.width) < 2
                && abs(frame.size.height - target.frame.size.height) < 2
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// Finds the prompt composer by role AND description together.
    ///
    /// Never "the first text area found". A Claude window holds other editable regions, and writing a
    /// prompt into one of them is a worse outcome than reporting the composer missing, so an unmatched
    /// search fails rather than falling back.
    private func findComposer(in element: AXUIElement, depth: Int, visited: inout Set<UInt>) -> AXUIElement? {
        guard depth < Self.maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if string(element, kAXRoleAttribute) == kAXTextAreaRole,
           string(element, kAXDescriptionAttribute) == Config.claudeComposerDescription {
            return element
        }
        var rawChildren: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren) == .success,
              let children = rawChildren as? [AXUIElement]
        else { return nil }
        for child in children {
            if let found = findComposer(in: child, depth: depth + 1, visited: &visited) { return found }
        }
        return nil
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return "" }
        return value as? String ?? ""
    }

    private func frame(of element: AXUIElement) -> CGRect? {
        guard let position = point(element, kAXPositionAttribute),
              let size = size(element, kAXSizeAttribute)
        else { return nil }
        return CGRect(origin: position, size: size)
    }

    private func point(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let value = axValue(element, attribute, .cgPoint) else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
        return point
    }

    private func size(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        guard let value = axValue(element, attribute, .cgSize) else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue(value, .cgSize, &size) else { return nil }
        return size
    }

    private func axValue(_ element: AXUIElement, _ attribute: String, _ type: AXValueType) -> AXValue? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let value = raw, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        let axValue = value as! AXValue
        return AXValueGetType(axValue) == type ? axValue : nil
    }
}
