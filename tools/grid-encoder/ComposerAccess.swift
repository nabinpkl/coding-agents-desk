// Accessibility against another application's window, and the Space move that makes it possible.
//
// This is the native half of the composer path and nothing else. It does not decide when to read,
// how long to wait between polls, when a wedged renderer should be restarted, or what any failure
// means to a viewer -- all of that is the sidecar's, in TypeScript, where changing it costs a
// `bun --watch` reload instead of an app build. What lives here is the part JavaScript cannot do:
// `AXUIElement*`, the private `AXManualAccessibility` latch, and SkyLight's window move.
//
// Nothing in here raises, activates, or focuses an application, with ONE exception that is marked
// where it happens. `AXUIElementSetAttributeValue` on a value does not require the target to be
// frontmost, which is the whole reason this approach is viable: the panel can fill a composer on
// another Desktop without taking the user's screen.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// `WindowInputReason` from `agent-feed/wire/desktopWindow.ts`. Codes, never prose: the panel owns
/// the wording, and a code a peer does not recognize degrades to "unavailable, reason unknown".
struct ComposerFailure: Error {
    let reason: String
    static let accessibilityDenied = ComposerFailure(reason: "ax-denied")
    static let noWindow = ComposerFailure(reason: "no-window")
    static let composerMissing = ComposerFailure(reason: "composer-missing")
    static let writeFailed = ComposerFailure(reason: "write-failed")
    static let questionMissing = ComposerFailure(reason: "question-missing")
    static let moveFailed = ComposerFailure(reason: "move-failed")
    static let windowMoverUnavailable = ComposerFailure(reason: "window-mover-unavailable")
}

/// The window to act on, as the sidecar resolved it. Sent with every verb rather than remembered,
/// because the sidecar re-resolves on its own poll and a target this process cached would be the
/// one thing that could disagree with it.
struct ComposerTarget {
    let claudeMainPid: pid_t
    let windowID: UInt32
    let frame: CGRect

    init?(_ request: [String: Any]) {
        guard let pid = (request["claudeMainPid"] as? NSNumber)?.int32Value,
              let windowID = (request["windowID"] as? NSNumber)?.uint32Value,
              let bounds = request["bounds"] as? [String: Any],
              let x = (bounds["x"] as? NSNumber)?.doubleValue,
              let y = (bounds["y"] as? NSNumber)?.doubleValue,
              let w = (bounds["w"] as? NSNumber)?.doubleValue,
              let h = (bounds["h"] as? NSNumber)?.doubleValue
        else { return nil }
        self.claudeMainPid = pid
        self.windowID = windowID
        self.frame = CGRect(x: x, y: y, width: w, height: h)
    }
}

enum ComposerAccess {
    /// Bounded so an unresponsive renderer cannot stall the caller. Chromium answers AX queries on
    /// its main thread, which a busy session can occupy.
    static let messagingTimeout: Float = 0.5
    /// Depth bound for the composer search. The prompt sits shallow inside the web contents; the
    /// bound is a guard against a cyclic tree, not a real limit.
    static let maxSearchDepth = 48

    /// The `AXDescription` Claude Desktop gives its prompt composer. Matched together with the
    /// `AXTextArea` role, never on role alone: a Claude window holds other editable regions, and
    /// typing a prompt into one of them is worse than reporting the composer missing.
    /// Env-overridable because it is another application's private UI string.
    static let composerDescription = ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_COMPOSER_DESC"]
        ?? "Prompt"
    /// The `AXDescription` on the AskUserQuestion panel's "Other" input. Part of the panel anchor
    /// triple, so a panel is never matched by title alone.
    static let questionOtherDescription =
        ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_QUESTION_OTHER_DESC"] ?? "Other option"

    // MARK: - Application-level

    static func frontmostApplicationPID() -> pid_t? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    /// Chromium builds its full accessibility tree only once it detects an assistive-technology
    /// client; without that, web content collapses to bare `AXGroup` shells and the composer does not
    /// exist to be found. `AXManualAccessibility` is Chromium's private override for that detection.
    /// It is write-only and one-way: reading it back always returns false regardless of what was set,
    /// and there is no way to turn it off short of relaunching Claude. So this cannot be made
    /// conditional on current state, and re-latching before every write is the only available shape.
    static func latchManualAccessibility(pid: pid_t) throws {
        guard AXIsProcessTrusted() else { throw ComposerFailure.accessibilityDenied }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        let result = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        guard result == .success else { throw ComposerFailure.accessibilityDenied }
    }

    // MARK: - Composer

    static func readComposer(_ target: ComposerTarget) throws -> String {
        try composerValue(for: try composerElement(target))
    }

    /// Sets the field's value and returns what it reads back.
    ///
    /// No key synthesis anywhere in this path, so no Return can be produced: the human commits the
    /// prompt in the real window unless `composer-submit` is asked for explicitly.
    ///
    /// The value commits asynchronously in Chromium, and a web contents mid-rebuild can answer the
    /// first read with the old value or the placeholder, so the read-back is settled rather than
    /// immediate. The caller judges the final value; this never guesses success.
    static func writeComposer(_ target: ComposerTarget, text: String, settleMs: Int, pollMs: Int) throws -> String {
        let composer = try composerElement(target)
        let result = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString)
        guard result == .success else { throw ComposerFailure.writeFailed }
        return settledReadBack(of: text, for: target, settleMs: settleMs, pollMs: pollMs)
    }

    /// Polls until the composer reads back the written text, or the settle budget expires.
    ///
    /// Each attempt re-scans the window rather than reusing the first element, because the web
    /// contents may rebuild its tree mid-settle. Any read error is a retry: the write already landed,
    /// so a momentary absence must not fail the reconciliation. After the budget, the final read-back
    /// is returned -- empty when the window holds nothing readable -- so the caller reports an honest
    /// mismatch instead of a guessed success.
    private static func settledReadBack(
        of text: String,
        for target: ComposerTarget,
        settleMs: Int,
        pollMs: Int
    ) -> String {
        let expected = lineEndCanonical(text)
        let deadline = Date().addingTimeInterval(Double(settleMs) / 1000)
        while Date() < deadline {
            if let readBack = try? composerValue(for: composerElement(target)),
               lineEndCanonical(readBack) == expected {
                return readBack
            }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
        }
        return (try? composerValue(for: composerElement(target))) ?? ""
    }

    /// Focuses the composer and presses Return, committing whatever it holds.
    ///
    /// This is the ONE place a write sends a key, and it is only reachable from the explicit submit
    /// verb. Setting `kAXFocusedAttribute` tells Chromium where Return is destined -- without it the
    /// post could land on a different focused element. That focus ACTIVATES the owning app and fronts
    /// its window, which is the requested outcome here, not the focus-stolen failure the
    /// non-activating fill path reports.
    ///
    /// The Return is posted per-pid because `AXUIElementPostKeyboardEvent` is unavailable in Swift; a
    /// targeted per-pid `CGEvent` reaches the now-focused field without a global HID post.
    static func submitComposer(_ target: ComposerTarget, settleMs: Int, pollMs: Int) throws -> String {
        guard AXIsProcessTrusted() else { throw ComposerFailure.accessibilityDenied }
        let composer = try composerElement(target)
        guard AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
        else { throw ComposerFailure.writeFailed }

        let returnKey: CGKeyCode = 36
        let source = CGEventSource(stateID: .hidSystemState)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: false)
        else { throw ComposerFailure.writeFailed }
        keyDown.postToPid(target.claudeMainPid)
        keyUp.postToPid(target.claudeMainPid)

        let deadline = Date().addingTimeInterval(Double(settleMs) / 1000)
        while Date() < deadline {
            let current = try composerValue(for: composer)
            if current.isEmpty { return "" }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
        }
        return try composerValue(for: composer)
    }

    /// Waits for the composer to exist after a window has been brought to this Desktop.
    ///
    /// Chromium builds a window's tree lazily and only for the current Space, so the composer is
    /// absent for a moment after a move-in and the first search reliably misses it. Polling until it
    /// appears is strictly better than a fixed sleep: it costs nothing once the tree is up, and it
    /// does not guess how long a busy renderer will take.
    ///
    /// The loop is native because it is a tight AX poll -- running it from the sidecar would be one
    /// stdin round trip per attempt. The BUDGET is the sidecar's, passed in, so the policy still
    /// changes without a rebuild.
    static func awaitComposer(_ target: ComposerTarget, timeoutMs: Int, pollMs: Int) throws {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        var last = ComposerFailure.composerMissing
        while Date() < deadline {
            do {
                _ = try composerElement(target)
                return
            } catch let failure as ComposerFailure {
                last = failure
            }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
        }
        throw last
    }

    /// Normalizes line endings for comparison. A read-back differing only in `\r\n` versus `\n` is
    /// the same text, and reporting that as a mismatch would fail every write on a pasted prompt.
    static func lineEndCanonical(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    // MARK: - Placeholder normalization

    /// Whether a read composer value is really just Claude's placeholder, not text.
    ///
    /// AX does NOT report the placeholder as such. The composer is a ProseMirror contenteditable
    /// (`AXDOMClassList = tiptap, ProseMirror`); the placeholder is real DOM text, so Chromium
    /// exposes it as the field's `AXValue` and does not set `AXPlaceholderValue`. The two states
    /// serialize differently:
    ///   - empty (placeholder): `AXValue` = `"Type / for commands\n"` and
    ///     `TextArea > Group > Group > StaticText("Type / for commands")`
    ///   - filled (any text):   `AXValue` = the text and `TextArea > Group > StaticText(...)`
    /// So a value is placeholder-only when it equals a descendant static-text plus exactly one
    /// trailing newline. That serialization exists only while the field holds no real text:
    /// ProseMirror collapses a trailing empty paragraph, so real text never ends in a bare `\n` (a
    /// blank second paragraph stays `\n\n`).
    static func isPlaceholderOnly(
        value: String,
        descendantTexts: [String],
        placeholderAttribute: String?
    ) -> Bool {
        if value.isEmpty { return true }
        // A future Claude using a real HTML placeholder attribute would set this and fold it into the
        // value; matching it treats the field as empty without guessing the string.
        if let placeholderAttribute, !placeholderAttribute.isEmpty, value == placeholderAttribute {
            return true
        }
        return descendantTexts.contains { !$0.isEmpty && value == $0 + "\n" }
    }

    /// Reads the composer's value, normalizing the placeholder serialization back to empty.
    ///
    /// The subtree walk needed to recognize the placeholder is skipped entirely for real text: only a
    /// value that ends in `\n` can be the placeholder, so the common read costs nothing extra.
    private static func composerValue(for composer: AXUIElement) throws -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(composer, kAXValueAttribute as CFString, &value) == .success
        else { throw ComposerFailure.writeFailed }
        let text = value as? String ?? ""
        guard !text.isEmpty, text.hasSuffix("\n") else { return text }
        let placeholder = string(composer, "AXPlaceholderValue")
        return isPlaceholderOnly(
            value: text,
            descendantTexts: descendantStaticTexts(of: composer, depth: 0),
            placeholderAttribute: placeholder.isEmpty ? nil : placeholder
        ) ? "" : text
    }

    private static func descendantStaticTexts(of element: AXUIElement, depth: Int) -> [String] {
        guard depth < maxSearchDepth else { return [] }
        var texts: [String] = []
        if string(element, kAXRoleAttribute) == kAXStaticTextRole {
            texts.append(string(element, kAXValueAttribute))
        }
        for child in children(of: element) {
            texts.append(contentsOf: descendantStaticTexts(of: child, depth: depth + 1))
        }
        return texts
    }

    // MARK: - Element lookup

    static func composerElement(_ target: ComposerTarget) throws -> AXUIElement {
        let window = try windowElement(target)
        var visited: Set<UInt> = []
        guard let composer = findComposer(in: window, depth: 0, visited: &visited) else {
            throw ComposerFailure.composerMissing
        }
        return composer
    }

    private static func windowElement(_ target: ComposerTarget) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw ComposerFailure.accessibilityDenied }
        let app = AXUIElementCreateApplication(target.claudeMainPid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        let windows = windowElements(of: app)
        guard !windows.isEmpty else { throw ComposerFailure.noWindow }
        guard let window = matchingWindow(target: target, among: windows) else {
            throw ComposerFailure.noWindow
        }
        return window
    }

    /// Node and text-area counts for one window subtree.
    ///
    /// The one breadcrumb that separates the two very different causes of `composer-missing`, which
    /// otherwise look identical from outside: a tree Chromium never built (a handful of bare
    /// `AXGroup` shells -- measured at 14 nodes for a window on another Space, against 403 for the
    /// same window on the active one), versus a full tree whose composer no longer carries the
    /// description this build matches on. Node and text-area counts tell them apart.
    static func treeCensus(_ target: ComposerTarget) -> [String: Any] {
        guard let window = try? windowElement(target) else {
            return ["nodes": 0, "textAreas": 0, "textAreaDescriptions": [], "reachable": false]
        }
        var visited: Set<UInt> = []
        let census = census(of: window, depth: 0, visited: &visited)
        return [
            "nodes": census.nodes,
            "textAreas": census.textAreas,
            "textAreaDescriptions": census.descriptions,
            "wantDescription": composerDescription,
            "reachable": true,
        ]
    }

    private static func census(
        of element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>
    ) -> (nodes: Int, textAreas: Int, descriptions: [String]) {
        guard depth < maxSearchDepth, visited.insert(CFHash(element)).inserted else { return (0, 0, []) }
        var nodes = 1
        var textAreas = 0
        var descriptions: [String] = []
        if string(element, kAXRoleAttribute) == kAXTextAreaRole {
            textAreas += 1
            descriptions.append(string(element, kAXDescriptionAttribute))
        }
        for child in children(of: element) {
            let sub = census(of: child, depth: depth + 1, visited: &visited)
            nodes += sub.nodes
            textAreas += sub.textAreas
            descriptions.append(contentsOf: sub.descriptions)
        }
        return (nodes, textAreas, descriptions)
    }

    /// Every window an application element will admit to, deduplicated.
    ///
    /// `AXWindows` alone is not enough: it comes back EMPTY for a process whose windows are all on
    /// another Space, which is precisely the case this feature exists for, and it reads as "Claude has
    /// no window" when the window is plainly there. `AXFocusedWindow` and `AXMainWindow` still answer
    /// in that state, so the union is what actually describes the application.
    private static func windowElements(of app: AXUIElement) -> [AXUIElement] {
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
    /// Accessibility exposes no window id, so the only shared fact between the two views is the
    /// frame. An ambiguous match refuses rather than guessing, because the cost of guessing is typing
    /// a prompt into the wrong conversation.
    ///
    /// The frame is checked EVEN WHEN only one window came back. It used to be taken on trust --
    /// "with a single window there is nothing to disambiguate" -- but this view is known-incomplete:
    /// as `windowElements` says above, `AXWindows` returns empty for windows on other Spaces, so the
    /// list often collapses to whatever `AXFocusedWindow` answers, which may be a different window of
    /// the same app entirely. One window here has never meant one window in the application, and
    /// accepting it unchecked turned a mis-targeted window into a silent wrong answer.
    private static func matchingWindow(target: ComposerTarget, among windows: [AXUIElement]) -> AXUIElement? {
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
    /// prompt into one of them is a worse outcome than reporting the composer missing, so an
    /// unmatched search fails rather than falling back.
    private static func findComposer(
        in element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>
    ) -> AXUIElement? {
        guard depth < maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if string(element, kAXRoleAttribute) == kAXTextAreaRole,
           string(element, kAXDescriptionAttribute) == composerDescription {
            return element
        }
        for child in children(of: element) {
            if let found = findComposer(in: child, depth: depth + 1, visited: &visited) { return found }
        }
        return nil
    }

    // MARK: - AskUserQuestion panel

    /// The panel's live state. CONTENT is deliberately absent: the question text, options, and
    /// multi-select shape come from the transcript feed's `AskUserQuestion` tool_use, and this only
    /// augments it with what a live read adds -- selection, the Other input, Submit's enabled state,
    /// and presence. `present: false` means "no panel", so never-shown and already-answered read the
    /// same, which is what the viewer needs.
    static func readQuestionState(_ target: ComposerTarget) throws -> [String: Any] {
        let window = try windowElement(target)
        guard let panel = findQuestionPanel(in: window) else { return ["present": false] }
        var selected: [Int] = []
        for (index, option) in questionOptions(in: panel).enumerated() where optionIsSelected(option) {
            selected.append(index)
        }
        let otherText = otherTextArea(in: panel).map { string($0, kAXValueAttribute) } ?? ""
        var state: [String: Any] = ["present": true, "selectedIndices": selected]
        if !otherText.isEmpty { state["otherText"] = otherText }
        if let submit = submitButton(in: panel), let enabled = boolValue(submit, kAXEnabledAttribute) {
            state["submitEnabled"] = enabled
        }
        return state
    }

    static func selectQuestionOption(_ target: ComposerTarget, index: Int, desired: Bool) throws {
        let panel = try questionPanel(target)
        let options = questionOptions(in: panel)
        guard options.indices.contains(index) else { throw ComposerFailure.questionMissing }
        let option = options[index]
        // Idempotent: press only when the element's state differs from the requested one, so a
        // retried action never toggles a checkbox twice. A single-select option button cannot be
        // un-pressed -- radio semantics -- so only a checkbox is pressed to clear a selection.
        let selected = optionIsSelected(option)
        if selected != desired, desired || string(option, kAXRoleAttribute) == kAXCheckBoxRole {
            try press(option)
        }
    }

    static func setQuestionOther(_ target: ComposerTarget, text: String) throws {
        let panel = try questionPanel(target)
        // Typing an Other answer implies the Other affordance is in use; the panel needs it checked
        // for the answer to count, and the press is idempotent when it already is.
        if let other = otherAffordance(in: panel), !optionIsSelected(other) { try press(other) }
        guard let textarea = otherTextArea(in: panel) else { throw ComposerFailure.questionMissing }
        guard AXUIElementSetAttributeValue(textarea, kAXValueAttribute as CFString, text as CFString) == .success
        else { throw ComposerFailure.writeFailed }
    }

    static func pressQuestionButton(_ target: ComposerTarget, kind: String) throws {
        let panel = try questionPanel(target)
        let button: AXUIElement?
        switch kind {
        case "submit": button = submitButton(in: panel)
        case "skip": button = skipButton(in: panel)
        case "dismiss": button = describedButton(in: panel, description: "Dismiss question")
        case "view-options": button = describedButton(in: panel, description: "View question options")
        default: throw ComposerFailure.questionMissing
        }
        guard let button else { throw ComposerFailure.questionMissing }
        try press(button)
    }

    private static func questionPanel(_ target: ComposerTarget) throws -> AXUIElement {
        guard let panel = findQuestionPanel(in: try windowElement(target)) else {
            throw ComposerFailure.questionMissing
        }
        return panel
    }

    /// Finds the panel by its structural signature, never by content.
    ///
    /// The panel is the smallest group holding all three of: a button whose title starts with
    /// `Submit` (`Submit ⏎` single-select, `Submit ⌘ ⏎` multi-select), a `Skip` button, and the Other
    /// input. The search anchors on Submit and climbs until a group containing the other two is
    /// found. This is what keeps every later lookup scoped: a Claude window contains other Dismiss
    /// and Submit-named controls (usage-limit banners, dialogs), and pressing one of those instead of
    /// the panel's would be the exact wrong-target failure this feature exists to avoid.
    private static func findQuestionPanel(in window: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        guard let submit = firstDescendant(in: window, depth: 0, visited: &visited, matching: isSubmitButton)
        else { return nil }
        var cursor = submit
        for _ in 0..<16 {
            guard let ancestor = parent(of: cursor) else { return nil }
            cursor = ancestor
            var skipVisited: Set<UInt> = []
            var textVisited: Set<UInt> = []
            let hasSkip = firstDescendant(
                in: ancestor, depth: 0, visited: &skipVisited, matching: isSkipButton
            ) != nil
            let hasOther = firstDescendant(
                in: ancestor, depth: 0, visited: &textVisited, matching: isOtherInput
            ) != nil
            if hasSkip && hasOther { return ancestor }
        }
        return nil
    }

    /// The panel's selectable options in document order -- the order the JSON `options` array arrives
    /// in, verified against the live app for both single-select buttons and multi-select checkboxes.
    ///
    /// Everything selectable inside the panel except the fixed controls: the Other affordance, Skip,
    /// Submit, and the header's View/Dismiss buttons. Title `Other` is the one fixed control that is
    /// itself selectable, so it is excluded by exact title rather than by role.
    private static func questionOptions(in panel: AXUIElement) -> [AXUIElement] {
        var visited: Set<UInt> = []
        var options: [AXUIElement] = []
        collectDescendants(of: panel, depth: 0, visited: &visited, into: &options) { element in
            let role = string(element, kAXRoleAttribute)
            guard role == kAXCheckBoxRole || role == kAXButtonRole else { return false }
            guard hasAction(element, kAXPressAction as String) else { return false }
            let title = string(element, kAXTitleAttribute)
            guard title != "Other", title != "Skip", !title.hasPrefix("Submit") else { return false }
            let description = string(element, kAXDescriptionAttribute)
            guard description != "View question options",
                  description != "Dismiss question",
                  description != questionOtherDescription else { return false }
            return true
        }
        return options
    }

    /// Whether a selectable element is chosen: a checkbox's value, a button's selection.
    private static func optionIsSelected(_ element: AXUIElement) -> Bool {
        if string(element, kAXRoleAttribute) == kAXCheckBoxRole {
            return boolValue(element, kAXValueAttribute) ?? false
        }
        return boolValue(element, kAXSelectedAttribute) ?? false
    }

    private static func isSubmitButton(_ element: AXUIElement) -> Bool {
        string(element, kAXRoleAttribute) == kAXButtonRole
            && string(element, kAXTitleAttribute).hasPrefix("Submit")
    }

    private static func isSkipButton(_ element: AXUIElement) -> Bool {
        string(element, kAXRoleAttribute) == kAXButtonRole
            && string(element, kAXTitleAttribute) == "Skip"
    }

    private static func isOtherInput(_ element: AXUIElement) -> Bool {
        string(element, kAXRoleAttribute) == kAXTextAreaRole
            && string(element, kAXDescriptionAttribute) == questionOtherDescription
    }

    /// The Other affordance -- a checkbox in multi-select, a button in single-select.
    private static func otherAffordance(in panel: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: panel, depth: 0, visited: &visited) { element in
            let role = string(element, kAXRoleAttribute)
            return (role == kAXCheckBoxRole || role == kAXButtonRole)
                && string(element, kAXTitleAttribute) == "Other"
        }
    }

    private static func otherTextArea(in panel: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: panel, depth: 0, visited: &visited, matching: isOtherInput)
    }

    private static func submitButton(in panel: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: panel, depth: 0, visited: &visited, matching: isSubmitButton)
    }

    private static func skipButton(in panel: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: panel, depth: 0, visited: &visited, matching: isSkipButton)
    }

    private static func describedButton(in panel: AXUIElement, description: String) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: panel, depth: 0, visited: &visited) { element in
            string(element, kAXRoleAttribute) == kAXButtonRole
                && string(element, kAXDescriptionAttribute) == description
        }
    }

    private static func press(_ element: AXUIElement) throws {
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            throw ComposerFailure.writeFailed
        }
    }

    // MARK: - Tree walking

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let children = raw as? [AXUIElement]
        else { return [] }
        return children
    }

    private static func firstDescendant(
        in element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>,
        matching: (AXUIElement) -> Bool
    ) -> AXUIElement? {
        guard depth < maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if matching(element) { return element }
        for child in children(of: element) {
            if let found = firstDescendant(in: child, depth: depth + 1, visited: &visited, matching: matching) {
                return found
            }
        }
        return nil
    }

    private static func collectDescendants(
        of element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>,
        into result: inout [AXUIElement],
        matching: (AXUIElement) -> Bool
    ) {
        guard depth < maxSearchDepth, visited.insert(CFHash(element)).inserted else { return }
        if matching(element) { result.append(element) }
        for child in children(of: element) {
            collectDescendants(of: child, depth: depth + 1, visited: &visited, into: &result, matching: matching)
        }
    }

    private static func parent(of element: AXUIElement) -> AXUIElement? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &raw) == .success,
              let parent = raw, CFGetTypeID(parent) == AXUIElementGetTypeID()
        else { return nil }
        return parent as! AXUIElement
    }

    // MARK: - Attribute readers

    private static func string(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return "" }
        return value as? String ?? ""
    }

    /// Chromium reports checkboxes as CFBoolean; some bridges report NSNumber, so both are read.
    private static func boolValue(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else {
            return nil
        }
        if let value = raw as? Bool { return value }
        if let number = raw as? NSNumber { return number.boolValue }
        return nil
    }

    private static func hasAction(_ element: AXUIElement, _ action: String) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let names = names as? [String]
        else { return false }
        return names.contains(action)
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        guard let position = axPoint(element, kAXPositionAttribute),
              let size = axSize(element, kAXSizeAttribute)
        else { return nil }
        return CGRect(origin: position, size: size)
    }

    private static func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let value = axValue(element, attribute, .cgPoint) else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
        return point
    }

    private static func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        guard let value = axValue(element, attribute, .cgSize) else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue(value, .cgSize, &size) else { return nil }
        return size
    }

    private static func axValue(_ element: AXUIElement, _ attribute: String, _ type: AXValueType) -> AXValue? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let value = raw, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        let axValue = value as! AXValue
        return AXValueGetType(axValue) == type ? axValue : nil
    }
}

// MARK: - Window movement

/// Moves another application's window between user Spaces.
///
/// `SLSMoveWindowsToManagedSpace` is ignored for third-party windows when called from an ordinary
/// connection. macOS 26.4 added a bridged operation that accepts a WindowServer id directly and
/// therefore needs no Accessibility reference for the window, which is what this uses.
///
/// The host owns the same operation for its OWN windows, under the shared placement authority. This
/// is not that: a foreign app's composer move-in and move-back is a borrow, not placement, and it
/// consults no ordinals and no display topology. The two never touch the same windows.
enum WindowSpaceMover {
    static var isAvailable: Bool {
        guard SkyLight.shared != nil,
              let operationClass = NSClassFromString("SLSBridgedMoveWindowsToManagedSpaceOperation")
        else { return false }
        return class_getInstanceMethod(operationClass, NSSelectorFromString("initWithWindows:spaceID:")) != nil
            && class_getInstanceMethod(operationClass, NSSelectorFromString("performWithWMBridgeDelegate")) != nil
    }

    static func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
        guard isAvailable,
              let operationClass = NSClassFromString("SLSBridgedMoveWindowsToManagedSpaceOperation")
        else { throw ComposerFailure.windowMoverUnavailable }
        let typedClass = unsafeBitCast(operationClass, to: BridgedWindowManagementOperation.Type.self)
        let operation = typedClass.init(windows: [NSNumber(value: windowID)] as NSArray, spaceID: targetSpaceID)
        operation.performWithWMBridgeDelegate()

        // Fire-and-verify: the operation reports nothing, so membership is re-read rather than
        // trusted. A move that silently did not take would otherwise leave the caller writing into a
        // window still on another Space, which is the collapsed-tree case all over again.
        guard let sl = SkyLight.shared else { throw ComposerFailure.moveFailed }
        let spaces = DesktopAudit.spaceIDs(sl: sl, cid: sl.mainConnectionID(), windowID: windowID)
        guard spaces == [targetSpaceID] else { throw ComposerFailure.moveFailed }
    }
}

/// A compile-time view of selectors implemented by SkyLight's private operation class. The class does
/// not declare this protocol, so the metatype is checked for both selectors before the cast.
@objc private protocol BridgedWindowManagementOperation: AnyObject {
    init(windows: NSArray, spaceID: UInt64)
    func performWithWMBridgeDelegate()
}
