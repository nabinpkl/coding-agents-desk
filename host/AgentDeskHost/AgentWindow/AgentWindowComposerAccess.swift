import AgentDeskWire
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import os

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

    private let reviver: AgentWindowRendererReviving
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    init(reviver: AgentWindowRendererReviving = AgentWindowRendererReviver()) {
        self.reviver = reviver
    }

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
    }

    /// Waits for the composer to exist, after a window has been brought to this Desktop.
    ///
    /// Chromium builds a window's tree lazily and only for the current Space, so the composer is absent
    /// for a moment after the move-in and the first search reliably misses it. Polling until it appears
    /// is what the validated prototype did, and it is strictly better than a fixed sleep: it costs
    /// nothing once the tree is up, and it does not guess how long a busy renderer will take. Blocking
    /// is acceptable because the whole composer path runs off the main thread.
    func awaitComposer(for target: AgentWindowSessionTarget) throws {
        let deadline = Date().addingTimeInterval(Config.claudeComposerMaterializeTimeout)
        var lastError: AgentWindowInputReason = .composerMissing
        while Date() < deadline {
            do {
                _ = try composerElement(for: target)
                reviver.noteComposerFound(for: target.claudeMainPid)
                return
            } catch let reason as AgentWindowInputReason {
                lastError = reason
                // A window that was just moved here is expected to build its tree on its own, but a
                // wedged web contents never will. The reviver's continuous-missing gate means a slow
                // build is never touched, and a wedge recovers within it.
                if reason == .composerMissing {
                    reviveIfDue(for: target)
                }
            }
            Thread.sleep(forTimeInterval: Config.claudeComposerMaterializePollInterval)
        }
        throw lastError
    }

    func readComposer(for target: AgentWindowSessionTarget) throws -> String {
        let composer = try composerElementOrRecover(for: target)
        return try composerValue(for: composer)
    }

    func writeComposer(_ text: String, for target: AgentWindowSessionTarget) throws -> String {
        let composer = try composerElementOrRecover(for: target)
        // Sets the field's value. There is no key synthesis anywhere in this path, so no Return can be
        // produced: the human commits the prompt in the real window.
        let result = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString)
        guard result == .success else { throw AgentWindowInputReason.writeFailed }
        // The value commits asynchronously in Chromium, and a web contents mid-rebuild can answer the
        // first read with the old value or the placeholder. A landed write must not fail reconciliation
        // on that stale first read, so the read-back gets the same settle budget a submit gets; the
        // writer still judges the final value, never a guessed success.
        return try settledReadBack(of: text, for: target)
    }

    /// Polls the composer until it reads back the written text, or the settle budget expires.
    ///
    /// Each attempt re-scans the window rather than reusing the first element, because the web contents
    /// may rebuild its tree mid-settle. Any read error is a retry: the write already landed, so a
    /// momentary absence must not fail the reconciliation. After the budget, the final read-back is
    /// returned -- empty when the window holds nothing readable -- so the writer reports an honest
    /// mismatch instead of a guessed success.
    private func settledReadBack(of text: String, for target: AgentWindowSessionTarget) throws -> String {
        let expected = AgentWindowComposerWriter.lineEndCanonical(text)
        let deadline = Date().addingTimeInterval(Config.claudeComposerVerifySettleTimeout)
        while Date() < deadline {
            do {
                let readBack = try composerValue(for: composerElement(for: target))
                if AgentWindowComposerWriter.lineEndCanonical(readBack) == expected {
                    return readBack
                }
            } catch {
                // Tree mid-rebuild; keep polling.
            }
            Thread.sleep(forTimeInterval: Config.claudeComposerVerifySettlePollInterval)
        }
        return (try? composerValue(for: composerElement(for: target))) ?? ""
    }

    /// Focuses the composer and presses Return, committing whatever it holds.
    ///
    /// This is the ONE place an AgentDesk write sends a key, and it is only reachable from the explicit
    /// Enter action, not from the fill path. Setting `kAXFocusedAttribute` on the composer tells
    /// Chromium where Return is destined -- without that, the post could land on a different focused
    /// element. The Return itself is posted per-pid, because `AXUIElementPostKeyboardEvent` is marked
    /// unavailable in Swift; a targeted per-pid CGEvent reaches the now-focused field.
    ///
    /// Returns the value read after a bounded settle for Chromium to clear the field, which is how a
    /// successful send reads. A field that has not cleared by then is reported holding its remaining
    /// text, so the panel learns the send did not obviously land.
    func submitComposer(for target: AgentWindowSessionTarget) throws -> String {
        guard AXIsProcessTrusted() else { throw AgentWindowInputReason.accessibilityDenied }

        // Focus the composer so the Return is destined at the field the prompt was just written into.
        // This activates the owning app and fronts its window -- the submit path is the user asking for
        // the prompt to run, so that is the requested outcome, not the focus-stolen failure the
        // non-activating fill path reports.
        let composer = try composerElementOrRecover(for: target)
        let focusResult = AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard focusResult == .success else { throw AgentWindowInputReason.writeFailed }

        // Press Return in the owning process. `AXUIElementPostKeyboardEvent` is marked unavailable in
        // Swift (deprecated macOS 10.9), so the key is posted as a per-pid CGEvents instead, which
        // reaches the now-focused field without a global HID post.
        let returnKey: CGKeyCode = 36
        let source = CGEventSource(stateID: .hidSystemState)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: false)
        guard let keyDown, let keyUp else { throw AgentWindowInputReason.writeFailed }
        keyDown.postToPid(target.claudeMainPid)
        keyUp.postToPid(target.claudeMainPid)

        let deadline = Date().addingTimeInterval(Config.claudeComposerSubmitSettleTimeout)
        while Date() < deadline {
            let current = try composerValue(for: composer)
            if current.isEmpty { return "" }
            Thread.sleep(forTimeInterval: Config.claudeComposerSubmitSettlePollInterval)
        }
        return try composerValue(for: composer)
    }

    // MARK: - Placeholder normalization

    /// Decides whether a read composer value is really just Claude's placeholder, not text.
    ///
    /// AX does NOT report the placeholder as such. A ground-truth probe of Claude Desktop 1.26832.0
    /// shows the composer is a ProseMirror contenteditable (`AXDOMClassList = tiptap, ProseMirror`);
    /// the placeholder is real DOM text, so Chromium exposes it as the field's `AXValue` and does not
    /// set `AXPlaceholderValue`. The two states serialize differently:
    ///   - empty (placeholder): `AXValue` = `"Type / for commands\n"` and
    ///     `TextArea > Group > Group > StaticText("Type / for commands")`
    ///   - filled (any text):   `AXValue` = the text and `TextArea > Group > StaticText(...)`
    /// So a value is placeholder-only when it equals a descendant static-text plus exactly one trailing
    /// newline. That serialization exists only while the field holds no real text: ProseMirror
    /// collapses a trailing empty paragraph, so real text never ends in a bare `\n` (a blank second
    /// paragraph stays `\n\n`). Pure so the rule is unit-testable; the accessibility reachability lives
    /// in `composerValue(for:)`.
    static func isPlaceholderOnly(
        value: String,
        descendantTexts: [String],
        placeholderAttribute: String?
    ) -> Bool {
        if value.isEmpty { return true }
        // A future Claude that uses a real HTML placeholder attribute would set this and fold it into
        // the value; matching it treats the field as empty without guessing the string.
        if let placeholderAttribute, !placeholderAttribute.isEmpty, value == placeholderAttribute {
            return true
        }
        return descendantTexts.contains { !$0.isEmpty && value == $0 + "\n" }
    }

    /// Reads the composer's value, normalizing Claude's placeholder serialization back to empty.
    ///
    /// The subtree walk needed to recognize the placeholder is skipped entirely for real text: only a
    /// value that ends in `\n` can be the placeholder, so the common read costs nothing extra.
    private func composerValue(for composer: AXUIElement) throws -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(composer, kAXValueAttribute as CFString, &value) == .success
        else { throw AgentWindowInputReason.writeFailed }
        let text = value as? String ?? ""
        guard !text.isEmpty, text.hasSuffix("\n") else { return text }
        let placeholder = string(composer, "AXPlaceholderValue")
        let descendantTexts = descendantStaticTexts(of: composer, depth: 0)
        return Self.isPlaceholderOnly(
            value: text,
            descendantTexts: descendantTexts,
            placeholderAttribute: placeholder.isEmpty ? nil : placeholder
        ) ? "" : text
    }

    /// Every `AXStaticText` value in the subtree, bounded by the same cycle guard as the composer search.
    private func descendantStaticTexts(of element: AXUIElement, depth: Int) -> [String] {
        guard depth < Self.maxSearchDepth else { return [] }
        var texts: [String] = []
        if string(element, kAXRoleAttribute) == kAXStaticTextRole {
            texts.append(string(element, kAXValueAttribute))
        }
        var rawChildren: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren) == .success,
              let children = rawChildren as? [AXUIElement]
        else { return texts }
        for child in children {
            texts.append(contentsOf: descendantStaticTexts(of: child, depth: depth + 1))
        }
        return texts
    }

    // MARK: - Element lookup

    /// The composer, recovering a wedged web contents before giving up.
    ///
    /// A window can sit on the current Space, focused, with the composer plainly on screen, and still
    /// expose no prompt field: Chromium only materializes a web contents' accessibility tree under
    /// conditions this host cannot control, and a contents that never built its tree reads as
    /// "composer missing". The deterministic recovery is to terminate Claude's renderer children --
    /// Chromium respawns the contents fresh, which builds the tree (verified against the live app).
    /// The reviver's continuous-missing gate means a tree that flaps briefly is never killed, and the
    /// cooldown bounds a tree that never rebuilds. When a revive actually fires, the respawned
    /// contents gets a short bounded wait; otherwise the caller fails fast and the coordinator's own
    /// poll retries.
    private func composerElementOrRecover(for target: AgentWindowSessionTarget) throws -> AXUIElement {
        do {
            let element = try composerElement(for: target)
            reviver.noteComposerFound(for: target.claudeMainPid)
            return element
        } catch AgentWindowInputReason.composerMissing {
            guard !reviveIfDue(for: target).isEmpty else {
                throw AgentWindowInputReason.composerMissing
            }
            let deadline = Date().addingTimeInterval(Config.claudeRendererReviveWait)
            while Date() < deadline {
                Thread.sleep(forTimeInterval: Config.claudeComposerMaterializePollInterval)
                do {
                    let element = try composerElement(for: target)
                    reviver.noteComposerFound(for: target.claudeMainPid)
                    return element
                } catch AgentWindowInputReason.composerMissing {
                    continue
                }
            }
            throw AgentWindowInputReason.composerMissing
        }
    }

    /// Records a composer-missing observation and, when the revive gates allow, terminates the
    /// target's renderer children. Returns the terminated pids so the caller can log and wait.
    private func reviveIfDue(for target: AgentWindowSessionTarget) -> [pid_t] {
        let killed = reviver.noteComposerMissing(for: target.claudeMainPid, now: Date())
        if !killed.isEmpty {
            logger.warning(
                "composer absent in window \(target.windowID, privacy: .public); terminated renderer(s) \(killed, privacy: .public) for pid \(target.claudeMainPid, privacy: .public)"
            )
        }
        return killed
    }

    private func composerElement(for target: AgentWindowSessionTarget) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw AgentWindowInputReason.accessibilityDenied }
        let app = AXUIElementCreateApplication(target.claudeMainPid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)

        let windows = windowElements(of: app)
        guard !windows.isEmpty else { throw AgentWindowInputReason.noWindow }
        guard let window = matchingWindow(target: target, among: windows) else {
            throw AgentWindowInputReason.noWindow
        }
        var visited: Set<UInt> = []
        guard let composer = findComposer(in: window, depth: 0, visited: &visited) else {
            throw AgentWindowInputReason.composerMissing
        }
        return composer
    }

    /// Every window an application element will admit to, deduplicated.
    ///
    /// `AXWindows` alone is not enough: it comes back EMPTY for a process whose windows are all on
    /// another Space, which is precisely the case this feature exists for, and it reads as "Claude has
    /// no window" when the window is plainly there. `AXFocusedWindow` and `AXMainWindow` still answer
    /// in that state, so the union is what actually describes the application.
    private func windowElements(of app: AXUIElement) -> [AXUIElement] {
        var found: [AXUIElement] = []
        var seen: Set<UInt> = []
        func add(_ element: AXUIElement) {
            if seen.insert(CFHash(element)).inserted { found.append(element) }
        }
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
           let windows = raw as? [AXUIElement] {
            windows.forEach(add)
        }
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, attribute as CFString, &value) == .success,
                  let window = value, CFGetTypeID(window) == AXUIElementGetTypeID()
            else { continue }
            add(window as! AXUIElement)
        }
        return found
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
