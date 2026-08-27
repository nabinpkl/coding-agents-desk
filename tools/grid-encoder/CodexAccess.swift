// Codex Desktop's window identity and composer, over Accessibility.
//
// A different problem from Claude's, despite the same-looking verbs. Claude Desktop shows ONE window
// per instance and the session-to-window mapping is the process tree, so the pid alone nearly
// resolves it. Codex Desktop runs one `codex app-server` child per thread of every window and no
// argv or state file names the thread in a window-distinguishing way, so identity lives in the
// accessibility tree itself: a window exposes the thread it is showing either as its header bar
// (title button plus `Project:` popup) or as the first row of its Recents list. This file produces
// those summaries; the MATCHING is TypeScript's, in the sidecar, because which of the layered rules
// applies is exactly the kind of thing that gets revised.
//
// The window handle cache is the second difference and the reason this cannot be a one-shot process.
// `AXWindows` lists only the active Space's windows, so a window on another Desktop is unreachable
// unless a handle was captured while it was here. Handles are held across requests, which needs a
// resident process -- the same thing `ComposerObserver` needs.

import ApplicationServices
import CoreGraphics
import Foundation

/// Private, and load-bearing: the public Accessibility API exposes no window id, so correlating an
/// `AXUIElement` to the audited `CGWindowID` would otherwise be a frame comparison. Frames do not
/// identify a window -- two maximized Codex windows on two Desktops have the SAME frame, and the
/// comparison does not degrade there, it refuses.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

final class CodexAccess {
    static let shared = CodexAccess()

    /// Bounded so an unresponsive renderer cannot stall the caller. Chromium answers AX queries on
    /// its main thread, which a busy session can occupy.
    static let messagingTimeout: Float = 0.5
    static let maxSearchDepth = 48

    /// The `AXDescription` on Codex Desktop's composer. Matched together with the `AXTextArea` role,
    /// never on role alone. Env-overridable: another application's private UI string.
    static let composerDescription = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_COMPOSER_DESC"]
        ?? "Do anything"

    /// Both spellings of the sidebar toggle: the label flips with the sidebar's state, and a
    /// collapsed sidebar is not a reason to refuse to type into the composer.
    static let sidebarToggleLabels: Set<String> = ["Hide sidebar", "Show sidebar"]

    /// Chrome buttons that share the header bar with the thread title, excluded so a title match
    /// never lands on navigation or section chrome.
    static let headerChromeTitles: Set<String> = [
        "Back", "Forward", "Hide sidebar", "Show sidebar", "Search", "Open in",
        "Pull requests", "Sites", "Scheduled", "Plugins",
        "New chat", "Quick chat", "Add to chat", "More details", "Ask in side chat",
    ]

    /// Window elements captured by an acquisition sweep, keyed by WindowServer's id.
    ///
    /// One authoritative home for "which Codex windows can this process reach". Guarded because the
    /// command thread and the observer's run loop both read it.
    private let lock = NSLock()
    private var handles: [CGWindowID: AXUIElement] = [:]

    // MARK: - Window identity

    func holdsWindow(_ windowID: CGWindowID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return handles[windowID] != nil
    }

    /// Captures a handle for every window the app currently lists.
    ///
    /// Called while the windows are on the active Desktop, which is the only moment the app admits to
    /// them. This is what makes an off-Desktop Codex window addressable at all.
    func captureWindows(mainPid: pid_t) {
        guard AXIsProcessTrusted() else { return }
        materializeTree(mainPid: mainPid)
        let app = application(mainPid)
        for window in scanWindowElements(of: app) {
            guard let id = windowID(of: window) else { continue }
            lock.lock()
            handles[id] = window
            lock.unlock()
        }
    }

    /// Drops handles for windows that no longer exist, so a reused `CGWindowID` cannot be addressed
    /// through a dead element.
    func forgetWindows(keeping live: Set<CGWindowID>) {
        lock.lock()
        defer { lock.unlock() }
        handles = handles.filter { live.contains($0.key) }
    }

    /// Identity of every window the Codex process exposes, for the sidecar to match threads against.
    func windowSummaries(mainPid: pid_t) throws -> [[String: Any]] {
        guard AXIsProcessTrusted() else { throw ComposerFailure.accessibilityDenied }
        materializeTree(mainPid: mainPid)
        let app = application(mainPid)
        return windowElements(of: app).compactMap { window in
            // A window with no id cannot be addressed later, so it is not a candidate. Skipped
            // rather than frame-guessed: guessing is how a prompt lands in the wrong conversation.
            guard let id = windowID(of: window), let frame = frame(of: window) else { return nil }
            let popup = projectPopup(in: window)
            // The popup counts as window identity ONLY when it sits in the header bar: the sidebar
            // rows carry the same `Project actions for <name>` description, and a window on the
            // projects view has no header bar to anchor to (no chat is open in it).
            let header = popup.flatMap { headerGroup(of: window, containingProjectPopup: $0) }
            let project = header.flatMap { _ in popup.flatMap { projectName(from: $0) } } ?? ""
            let title = header.flatMap { threadTitleButton(in: $0) }
                .map { string($0, kAXTitleAttribute) } ?? ""
            var summary: [String: Any] = [
                "windowID": id,
                "threadTitle": title,
                "projectName": project,
                "bounds": ["x": frame.origin.x, "y": frame.origin.y,
                           "w": frame.size.width, "h": frame.size.height],
            ]
            if let recents = recentsFirstRow(in: window) { summary["recentsFirstRow"] = recents }
            return summary
        }
    }

    /// The title of the first row of the window's Recents list: the thread this window is showing.
    ///
    /// The projects/Recents layout exposes no header identity, but its sidebar pins the window's
    /// current thread as the first row of the list inside the `Recents` button's own group (probed
    /// live: the first row was the window's thread even when another thread had more recent
    /// activity, and it followed the thread when the window switched). The Recents button is matched
    /// by title; its immediate parent group is the list's home, so the per-project lists elsewhere in
    /// the sidebar can never satisfy the anchor.
    private func recentsFirstRow(in window: AXUIElement) -> String? {
        var visited: Set<UInt> = []
        guard let recents = firstDescendant(in: window, depth: 0, visited: &visited, matching: { element in
            string(element, kAXRoleAttribute) == kAXButtonRole && label(of: element) == "Recents"
        }), let listParent = parent(of: recents) else { return nil }
        var listVisited: Set<UInt> = []
        guard let list = firstDescendant(in: listParent, depth: 0, visited: &listVisited, matching: { element in
            guard string(element, kAXRoleAttribute) == kAXListRole else { return false }
            return firstRowTitle(of: element) != nil
        }) else { return nil }
        return firstRowTitle(of: list)
    }

    /// The first row's thread title: the first titled descendant of the list's first child.
    private func firstRowTitle(of list: AXUIElement) -> String? {
        guard let firstRow = children(of: list).first else { return nil }
        var visited: Set<UInt> = []
        return firstDescendant(in: firstRow, depth: 0, visited: &visited, matching: { element in
            let role = string(element, kAXRoleAttribute)
            let title = string(element, kAXTitleAttribute)
            return (role == kAXButtonRole || role == kAXStaticTextRole)
                && !title.isEmpty && !Self.headerChromeTitles.contains(title)
        }).map { string($0, kAXTitleAttribute) }
    }

    /// Waits for Codex Desktop's web contents to materialize its accessibility tree.
    ///
    /// The app builds its full Chromium tree lazily: with no assistive-technology client attached the
    /// web contents collapse to bare shells, and a probe measured the full tree appearing within two
    /// seconds of a client attaching. There is no `AXManualAccessibility` latch to set -- the
    /// attribute is unsupported on this app element -- so attaching and waiting is the only
    /// mechanism. This process is a long-lived client, so after the first wait the tree stays up for
    /// its lifetime and the budget only bounds a renderer that never answers.
    private func materializeTree(mainPid: pid_t, timeoutMs: Int = 20_000, pollMs: Int = 200) {
        let app = application(mainPid)
        if hasTextArea(in: app) { return }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
            if hasTextArea(in: app) { return }
        }
    }

    private func hasTextArea(in element: AXUIElement) -> Bool {
        var visited: Set<UInt> = []
        return firstDescendant(in: element, depth: 0, visited: &visited, matching: {
            string($0, kAXRoleAttribute) == kAXTextAreaRole
        }) != nil
    }

    /// The project popup in the window's header bar, matched by description.
    ///
    /// Two live spellings exist: the chat view reads `Project: <name>`, the sidebar's project rows
    /// read `Project actions for <name>`. Only the popup INSIDE the header bar counts as window
    /// identity, which `headerGroup` is what enforces.
    private func projectPopup(in window: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: window, depth: 0, visited: &visited, matching: { element in
            guard string(element, kAXRoleAttribute) == kAXPopUpButtonRole else { return false }
            let description = string(element, kAXDescriptionAttribute)
            return description.hasPrefix("Project: ") || description.hasPrefix("Project actions for ")
        })
    }

    private func projectName(from popup: AXUIElement) -> String? {
        let description = string(popup, kAXDescriptionAttribute)
        for prefix in ["Project: ", "Project actions for "] where description.hasPrefix(prefix) {
            let name = String(description.dropFirst(prefix.count))
            return name.isEmpty ? nil : name
        }
        return nil
    }

    /// The header bar holding the project popup: the popup's ancestor group that also contains the
    /// sidebar toggle. The thread title button is found INSIDE this group, so the sidebar's thread
    /// list -- a separate region that also carries titles -- can never satisfy the match.
    ///
    /// The toggle is matched by `label`, not by title. Matching `AXTitle == "Hide sidebar"` is what
    /// broke this path once: the app labels icon-only chrome through `AXDescription`, so the anchor
    /// read empty, every window resolved to no identity, and the panel showed "no window" for every
    /// Codex thread.
    private func headerGroup(of window: AXUIElement, containingProjectPopup popup: AXUIElement) -> AXUIElement? {
        var cursor = popup
        for _ in 0..<8 {
            guard let ancestor = parent(of: cursor) else { return nil }
            cursor = ancestor
            var visited: Set<UInt> = []
            if firstDescendant(in: ancestor, depth: 0, visited: &visited, matching: { element in
                string(element, kAXRoleAttribute) == kAXButtonRole
                    && Self.sidebarToggleLabels.contains(label(of: element))
            }) != nil {
                return ancestor
            }
        }
        return nil
    }

    /// A control's visible label. Codex Desktop labels text buttons through `AXTitle` and icon-only
    /// chrome through `AXDescription`, and it has moved controls between the two, so anything matched
    /// by its label reads both. Deliberately NOT used for the thread title button: falling back to
    /// the description there would make every icon button in the header a candidate.
    private func label(of element: AXUIElement) -> String {
        let title = string(element, kAXTitleAttribute)
        return title.isEmpty ? string(element, kAXDescriptionAttribute) : title
    }

    /// The thread title button: the first titled button in the header bar that is not chrome.
    private func threadTitleButton(in header: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(in: header, depth: 0, visited: &visited, matching: { element in
            guard string(element, kAXRoleAttribute) == kAXButtonRole else { return false }
            let title = string(element, kAXTitleAttribute)
            return !title.isEmpty && !Self.headerChromeTitles.contains(title)
        })
    }

    // MARK: - Composer

    func readComposer(windowID: CGWindowID, mainPid: pid_t) throws -> String {
        try composerValue(for: try composerElement(windowID: windowID, mainPid: mainPid))
    }

    func writeComposer(
        _ text: String,
        windowID: CGWindowID,
        mainPid: pid_t,
        settleMs: Int,
        pollMs: Int
    ) throws -> String {
        let composer = try composerElement(windowID: windowID, mainPid: mainPid)
        guard AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString) == .success
        else { throw ComposerFailure.writeFailed }
        // The value commits asynchronously in Chromium, so a landed write must not fail
        // reconciliation on a stale first read; the caller still judges the final value.
        return settledReadBack(of: text, windowID: windowID, mainPid: mainPid, settleMs: settleMs, pollMs: pollMs)
    }

    private func settledReadBack(
        of text: String,
        windowID: CGWindowID,
        mainPid: pid_t,
        settleMs: Int,
        pollMs: Int
    ) -> String {
        let expected = ComposerAccess.lineEndCanonical(text)
        let deadline = Date().addingTimeInterval(Double(settleMs) / 1000)
        while Date() < deadline {
            if let readBack = try? readComposer(windowID: windowID, mainPid: mainPid),
               ComposerAccess.lineEndCanonical(readBack) == expected {
                return readBack
            }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
        }
        return (try? readComposer(windowID: windowID, mainPid: mainPid)) ?? ""
    }

    /// Focuses the composer and presses Return. The one place a Codex write sends a key.
    func submitComposer(windowID: CGWindowID, mainPid: pid_t, settleMs: Int, pollMs: Int) throws -> String {
        guard AXIsProcessTrusted() else { throw ComposerFailure.accessibilityDenied }
        let composer = try composerElement(windowID: windowID, mainPid: mainPid)
        guard AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
        else { throw ComposerFailure.writeFailed }
        let returnKey: CGKeyCode = 36
        let source = CGEventSource(stateID: .hidSystemState)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: false)
        else { throw ComposerFailure.writeFailed }
        keyDown.postToPid(mainPid)
        keyUp.postToPid(mainPid)
        let deadline = Date().addingTimeInterval(Double(settleMs) / 1000)
        while Date() < deadline {
            if try readComposer(windowID: windowID, mainPid: mainPid).isEmpty { return "" }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
        }
        return try readComposer(windowID: windowID, mainPid: mainPid)
    }

    func awaitComposer(windowID: CGWindowID, mainPid: pid_t, timeoutMs: Int, pollMs: Int) throws {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        var last = ComposerFailure.composerMissing
        while Date() < deadline {
            do {
                _ = try composerElement(windowID: windowID, mainPid: mainPid)
                return
            } catch let failure as ComposerFailure {
                last = failure
            }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000)
        }
        throw last
    }

    /// Whether a read composer value is really just the app's placeholder.
    ///
    /// AX does NOT report it as such: a ground-truth probe shows the empty value serializes as
    /// `"\nDo anything"` -- a leading newline plus the placeholder text the `AXDescription` also
    /// carries. Real text replaces that serialization.
    static func isPlaceholderOnly(value: String, description: String) -> Bool {
        if value.isEmpty { return true }
        guard !description.isEmpty else { return false }
        return value == "\n" + description
    }

    private func composerValue(for composer: AXUIElement) throws -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(composer, kAXValueAttribute as CFString, &value) == .success
        else { throw ComposerFailure.writeFailed }
        let text = value as? String ?? ""
        return Self.isPlaceholderOnly(value: text, description: Self.composerDescription) ? "" : text
    }

    // MARK: - Element lookup

    func composerElement(windowID: CGWindowID, mainPid: pid_t) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw ComposerFailure.accessibilityDenied }
        materializeTree(mainPid: mainPid)
        let app = application(mainPid)
        let windows = windowElements(of: app)
        guard !windows.isEmpty else { throw ComposerFailure.noWindow }
        // An identity, not a heuristic: both views name the same window by the same id. There is
        // deliberately no "only one window, so it must be that one" shortcut -- with several Codex
        // windows open, that shortcut is precisely how a prompt reaches the wrong conversation.
        guard let window = windows.first(where: { self.windowID(of: $0) == windowID }) else {
            throw ComposerFailure.noWindow
        }
        var visited: Set<UInt> = []
        guard let composer = findComposer(in: window, depth: 0, visited: &visited) else {
            throw ComposerFailure.composerMissing
        }
        return composer
    }

    /// Every window this access can reach: the handles it holds, plus whatever the app admits to now.
    ///
    /// Held handles come first because they are the complete set; the live scan only ever adds the
    /// active Space's windows and the last-focused one. A handle whose window has gone is dropped
    /// here rather than returned, so a closed window disappears from resolution on the next pass.
    private func windowElements(of app: AXUIElement) -> [AXUIElement] {
        lock.lock()
        let held = handles
        lock.unlock()
        var found: [AXUIElement] = []
        var seenIDs: Set<CGWindowID> = []
        var dead: [CGWindowID] = []
        for (id, window) in held.sorted(by: { $0.key < $1.key }) {
            // A detached element still answers its id but has no frame; that is the liveness probe.
            guard frame(of: window) != nil else { dead.append(id); continue }
            seenIDs.insert(id)
            found.append(window)
        }
        if !dead.isEmpty {
            lock.lock()
            for id in dead { handles[id] = nil }
            lock.unlock()
        }
        for window in scanWindowElements(of: app) {
            guard let id = windowID(of: window), !seenIDs.contains(id) else { continue }
            seenIDs.insert(id)
            found.append(window)
        }
        return found
    }

    /// What the application itself will admit to right now, which is never the whole story:
    /// `AXWindows` lists only the active Space's windows and comes back empty when they are all
    /// elsewhere, while `AXFocusedWindow` and `AXMainWindow` still name the last-focused one.
    private func scanWindowElements(of app: AXUIElement) -> [AXUIElement] {
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

    private func findComposer(in element: AXUIElement, depth: Int, visited: inout Set<UInt>) -> AXUIElement? {
        guard depth < Self.maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if string(element, kAXRoleAttribute) == kAXTextAreaRole,
           string(element, kAXDescriptionAttribute) == Self.composerDescription {
            return element
        }
        for child in children(of: element) {
            if let found = findComposer(in: child, depth: depth + 1, visited: &visited) { return found }
        }
        return nil
    }

    // MARK: - Primitives

    private func application(_ pid: pid_t) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        return app
    }

    private func windowID(of element: AXUIElement) -> CGWindowID? {
        var id: CGWindowID = 0
        return _AXUIElementGetWindow(element, &id) == .success && id != 0 ? id : nil
    }

    private func children(of element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let children = raw as? [AXUIElement]
        else { return [] }
        return children
    }

    private func firstDescendant(
        in element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>,
        matching: (AXUIElement) -> Bool
    ) -> AXUIElement? {
        guard depth < Self.maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if matching(element) { return element }
        for child in children(of: element) {
            if let found = firstDescendant(in: child, depth: depth + 1, visited: &visited, matching: matching) {
                return found
            }
        }
        return nil
    }

    private func parent(of element: AXUIElement) -> AXUIElement? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &raw) == .success,
              let parent = raw, CFGetTypeID(parent) == AXUIElementGetTypeID()
        else { return nil }
        return parent as! AXUIElement
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return "" }
        return value as? String ?? ""
    }

    private func frame(of element: AXUIElement) -> CGRect? {
        guard let position = axPoint(element, kAXPositionAttribute),
              let size = axSize(element, kAXSizeAttribute)
        else { return nil }
        return CGRect(origin: position, size: size)
    }

    private func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let value = axValue(element, attribute, .cgPoint) else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
        return point
    }

    private func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
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
