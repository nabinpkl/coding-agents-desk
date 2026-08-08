import AgentDeskWire
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import os

/// The seam that hands the resolver the identity of every open Codex Desktop window.
///
/// The codex mapping lives in the accessibility tree -- a window exposes the thread it shows either
/// as the header bar identity (title button + `Project:` popup) or as the first row of its Recents
/// list -- so the scan is the access's job and the pure matcher in `CodexWindowSessionResolver`
/// consumes its summaries.
protocol CodexWindowSummarizing {
    /// Identity of every window the codex process exposes, in AX enumeration order.
    func windowSummaries(mainPid: pid_t) -> [CodexWindowSummary]
}

/// The live Accessibility implementation of a composer read/write against Codex Desktop (ChatGPT.app).
///
/// Deliberately does nothing that raises, activates, or focuses an application: setting `AXValue` on a
/// field does not require the target to be frontmost, which is why the panel can fill a composer on
/// another Desktop without taking the user's screen. Unlike Claude Desktop, NO `AXManualAccessibility`
/// latch is needed or accepted here -- the codex app exposes its full Chromium tree to AX clients
/// natively (probed live: the latch attribute is unsupported on the app element while the tree is
/// fully materialized), and unlike Claude the tree exists for windows on OTHER Spaces too (probed
/// live), so reads and writes are free without a Space round trip. A window whose tree is missing
/// entirely is the one case the writer pays a bring-and-restore round trip for.
final class CodexWindowComposerAccess: CodexWindowAccessing, CodexWindowSummarizing {
    /// Bounded so an unresponsive renderer cannot stall the caller. Chromium answers AX queries on its
    /// main thread, which a busy session can occupy.
    static let messagingTimeout: Float = 0.5
    /// Depth bound for the header and composer searches. The header sits shallow inside the web
    /// contents; the bound is a guard against a cyclic tree, not a real limit.
    static let maxSearchDepth = 48

    private let logger = Logger(subsystem: Config.logSubsystem, category: "codex-window-composer")

    func frontmostApplicationPID() -> pid_t? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    // MARK: - Window identity

    func windowSummaries(mainPid: pid_t) -> [CodexWindowSummary] {
        guard AXIsProcessTrusted() else { return [] }
        materializeTree(mainPid: mainPid)
        let app = AXUIElementCreateApplication(mainPid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        return windowElements(of: app).compactMap { window in
            guard let frame = frame(of: window) else { return nil }
            let popup = projectPopup(in: window)
            // The popup counts as window identity ONLY when it sits in the header bar: the sidebar
            // rows carry the same `Project actions for <name>` description, and a window on the
            // projects view has no header bar to anchor to (no chat is open in it).
            let header = popup.flatMap { headerGroup(of: window, containingProjectPopup: $0) }
            let project = header.flatMap { _ in popup.flatMap { projectName(from: $0) } } ?? ""
            let title = header.flatMap { threadTitleButton(in: $0) }
                .map { string($0, kAXTitleAttribute) } ?? ""
            let recentsFirstRow = recentsFirstRow(in: window)
            return CodexWindowSummary(
                threadTitle: title,
                projectName: project,
                recentsFirstRow: recentsFirstRow,
                frame: frame
            )
        }
    }

    /// The title of the first row of the window's Recents list: the thread this window is showing.
    ///
    /// The projects/Recents layout exposes no header identity, but its sidebar pins the window's
    /// current thread as the first row of the list inside the `Recents` button's own group (probed
    /// live: the first row was the window's thread even when another thread had more recent activity,
    /// and it followed the thread when the window switched). The Recents button is matched by title;
    /// its immediate parent group is the list's home, so the per-project lists elsewhere in the
    /// sidebar can never satisfy the anchor. nil when the layout exposes no Recents list.
    private func recentsFirstRow(in window: AXUIElement) -> String? {
        var visited: Set<UInt> = []
        guard let recents = firstDescendant(
            in: window,
            depth: 0,
            visited: &visited,
            matching: { element in
                string(element, kAXRoleAttribute) == kAXButtonRole
                    && string(element, kAXTitleAttribute) == "Recents"
            }
        ), let listParent = parent(of: recents) else { return nil }
        var listVisited: Set<UInt> = []
        guard let list = firstDescendant(
            in: listParent,
            depth: 0,
            visited: &listVisited,
            matching: { element in
                guard string(element, kAXRoleAttribute) == kAXListRole else { return false }
                return firstRowTitle(of: element) != nil
            }
        ), let firstRow = firstRowTitle(of: list) else { return nil }
        return firstRow
    }

    /// The first row's thread title: the first titled descendant of the list's first child.
    private func firstRowTitle(of list: AXUIElement) -> String? {
        guard let firstRow = childElements(of: list).first else { return nil }
        var visited: Set<UInt> = []
        return firstDescendant(
            in: firstRow,
            depth: 0,
            visited: &visited,
            matching: { element in
                let role = string(element, kAXRoleAttribute)
                let title = string(element, kAXTitleAttribute)
                return (role == kAXButtonRole || role == kAXStaticTextRole)
                    && !title.isEmpty && !Self.headerChromeTitles.contains(title)
            }
        ).map { string($0, kAXTitleAttribute) }
    }

    /// Waits for Codex Desktop's web contents to materialize its accessibility tree.
    ///
    /// The codex app builds its full Chromium tree lazily: with no assistive-technology client
    /// attached the web contents collapse to bare shells (the composer and header simply do not
    /// exist), and a probe measured the full tree appearing within two seconds of an AX client
    /// attaching. There is no `AXManualAccessibility` latch to set -- the attribute is unsupported on
    /// this app element -- so attaching and waiting is the only materialization mechanism. The host
    /// is a long-lived client, so after the first wait the tree stays up for its lifetime; the budget
    /// only bounds a renderer that never answers.
    private func materializeTree(mainPid: pid_t) {
        let app = AXUIElementCreateApplication(mainPid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        if hasTextArea(in: app) { return }
        let deadline = Date().addingTimeInterval(Config.codexTreeMaterializeTimeout)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: Config.codexTreeMaterializePollInterval)
            if hasTextArea(in: app) { return }
        }
    }

    private func hasTextArea(in element: AXUIElement) -> Bool {
        var visited: Set<UInt> = []
        return firstDescendant(
            in: element,
            depth: 0,
            visited: &visited,
            matching: { string($0, kAXRoleAttribute) == kAXTextAreaRole }
        ) != nil
    }

    /// The project popup in the window's header bar, matched by description.
    ///
    /// Two live spellings exist: the chat view reads `Project: <name>`, and the project-list rows in
    /// the sidebar read `Project actions for <name>`. Only the popup INSIDE the header bar counts as
    /// window identity -- `headerGroup(of:containingProjectPopup:)` climbs from the popup to the bar,
    /// which is what excludes the sidebar's per-project rows.
    private func projectPopup(in window: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(
            in: window,
            depth: 0,
            visited: &visited,
            matching: { element in
                guard string(element, kAXRoleAttribute) == kAXPopUpButtonRole else { return false }
                let description = string(element, kAXDescriptionAttribute)
                return description.hasPrefix("Project: ")
                    || description.hasPrefix("Project actions for ")
            }
        )
    }

    private func projectName(from popup: AXUIElement) -> String? {
        let description = string(popup, kAXDescriptionAttribute)
        if description.hasPrefix("Project: ") {
            let name = String(description.dropFirst("Project: ".count))
            return name.isEmpty ? nil : name
        }
        if description.hasPrefix("Project actions for ") {
            let name = String(description.dropFirst("Project actions for ".count))
            return name.isEmpty ? nil : name
        }
        return nil
    }

    /// The header bar holding the project popup: the popup's ancestor group that also contains the
    /// `Hide sidebar` button. The thread title button is found INSIDE this group, so the sidebar's
    /// thread list -- a separate region that also carries titles -- can never satisfy the match.
    private func headerGroup(of window: AXUIElement, containingProjectPopup popup: AXUIElement?) -> AXUIElement? {
        guard let popup else { return nil }
        var cursor: AXUIElement = popup
        for _ in 0..<8 {
            guard let parent = parent(of: cursor) else { return nil }
            cursor = parent
            var visited: Set<UInt> = []
            if firstDescendant(
                in: parent,
                depth: 0,
                visited: &visited,
                matching: { element in
                    string(element, kAXRoleAttribute) == kAXButtonRole
                        && string(element, kAXTitleAttribute) == "Hide sidebar"
                }
            ) != nil {
                return parent
            }
        }
        return nil
    }

    /// Chrome buttons that share the header bar with the thread title, excluded so a title match never
    /// lands on navigation or section chrome.
    static let headerChromeTitles: Set<String> = [
        "Back", "Forward", "Hide sidebar", "Search", "Open in",
        "Pull requests", "Sites", "Scheduled", "Plugins",
        "New chat", "Quick chat", "Add to chat", "More details", "Ask in side chat",
    ]

    /// The thread title button: the first titled button in the header bar that is not chrome. The live
    /// app renders the thread's display title as a button in the bar (e.g. `Understand latest state`).
    private func threadTitleButton(in header: AXUIElement) -> AXUIElement? {
        var visited: Set<UInt> = []
        return firstDescendant(
            in: header,
            depth: 0,
            visited: &visited,
            matching: { element in
                guard string(element, kAXRoleAttribute) == kAXButtonRole else { return false }
                let title = string(element, kAXTitleAttribute)
                return !title.isEmpty && !Self.headerChromeTitles.contains(title)
            }
        )
    }

    // MARK: - Composer

    /// Waits for the composer to exist in the target window's tree. The recovery-move path brings the
    /// window to this Desktop first; the web contents can take a moment to build its tree after that.
    func awaitComposer(frame: CGRect, mainPid: pid_t) throws {
        let deadline = Date().addingTimeInterval(Config.codexComposerMaterializeTimeout)
        var lastError: AgentWindowInputReason = .composerMissing
        while Date() < deadline {
            do {
                _ = try composerElement(frame: frame, mainPid: mainPid)
                return
            } catch let reason as AgentWindowInputReason {
                lastError = reason
            }
            Thread.sleep(forTimeInterval: Config.codexComposerMaterializePollInterval)
        }
        throw lastError
    }

    func readComposer(frame: CGRect, mainPid: pid_t) throws -> String {
        try composerValue(for: try composerElement(frame: frame, mainPid: mainPid))
    }

    func composerElementIfAvailable(frame: CGRect, mainPid: pid_t) -> AXUIElement? {
        try? composerElement(frame: frame, mainPid: mainPid)
    }

    func writeComposer(_ text: String, frame: CGRect, mainPid: pid_t) throws -> String {
        let composer = try composerElement(frame: frame, mainPid: mainPid)
        let result = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFString)
        guard result == .success else { throw AgentWindowInputReason.writeFailed }
        // The value commits asynchronously in Chromium, so a landed write must not fail reconciliation
        // on a stale first read; the writer still judges the final value, never a guessed success.
        return try settledReadBack(of: text, frame: frame, mainPid: mainPid)
    }

    /// Polls the composer until it reads back the written text, or the settle budget expires.
    private func settledReadBack(of text: String, frame: CGRect, mainPid: pid_t) throws -> String {
        let expected = AgentWindowComposerWriter.lineEndCanonical(text)
        let deadline = Date().addingTimeInterval(Config.codexComposerVerifySettleTimeout)
        while Date() < deadline {
            do {
                let readBack = try readComposer(frame: frame, mainPid: mainPid)
                if AgentWindowComposerWriter.lineEndCanonical(readBack) == expected {
                    return readBack
                }
            } catch {
                // Tree mid-rebuild; keep polling.
            }
            Thread.sleep(forTimeInterval: Config.codexComposerVerifySettlePollInterval)
        }
        return (try? readComposer(frame: frame, mainPid: mainPid)) ?? ""
    }

    /// Focuses the composer and presses Return, committing whatever it holds.
    ///
    /// The one place a codex write sends a key, reachable only from the explicit Enter action. Setting
    /// `kAXFocusedAttribute` tells the web contents where Return is destined; the Return itself is
    /// posted per-pid because `AXUIElementPostKeyboardEvent` is marked unavailable in Swift. Returns
    /// the value read after a bounded settle, which a successful send clears.
    func submitComposer(frame: CGRect, mainPid: pid_t) throws -> String {
        guard AXIsProcessTrusted() else { throw AgentWindowInputReason.accessibilityDenied }
        let composer = try composerElement(frame: frame, mainPid: mainPid)
        let focusResult = AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard focusResult == .success else { throw AgentWindowInputReason.writeFailed }
        let returnKey: CGKeyCode = 36
        let source = CGEventSource(stateID: .hidSystemState)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: false)
        guard let keyDown, let keyUp else { throw AgentWindowInputReason.writeFailed }
        keyDown.postToPid(mainPid)
        keyUp.postToPid(mainPid)
        let deadline = Date().addingTimeInterval(Config.codexComposerSubmitSettleTimeout)
        while Date() < deadline {
            let current = try readComposer(frame: frame, mainPid: mainPid)
            if current.isEmpty { return "" }
            Thread.sleep(forTimeInterval: Config.codexComposerSubmitSettlePollInterval)
        }
        return try readComposer(frame: frame, mainPid: mainPid)
    }

    // MARK: - Placeholder normalization

    /// Decides whether a read composer value is really just the app's placeholder, not text.
    ///
    /// AX does NOT report the placeholder as such: a ground-truth probe shows the codex composer's
    /// empty value serializes as `"\nDo anything"` -- a leading newline plus the placeholder text the
    /// `AXDescription` also carries. Real text replaces that serialization. The rule is kept next to
    /// the code so a future app that changes the serialization has one place to adjust.
    static func isPlaceholderOnly(value: String, description: String) -> Bool {
        if value.isEmpty { return true }
        guard !description.isEmpty else { return false }
        return value == "\n" + description
    }

    private func composerValue(for composer: AXUIElement) throws -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(composer, kAXValueAttribute as CFString, &value) == .success
        else { throw AgentWindowInputReason.writeFailed }
        let text = value as? String ?? ""
        return Self.isPlaceholderOnly(value: text, description: Config.codexComposerDescription) ? "" : text
    }

    // MARK: - Element lookup

    private func composerElement(frame: CGRect, mainPid: pid_t) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw AgentWindowInputReason.accessibilityDenied }
        materializeTree(mainPid: mainPid)
        let app = AXUIElementCreateApplication(mainPid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        let windows = windowElements(of: app)
        guard !windows.isEmpty else { throw AgentWindowInputReason.noWindow }
        guard let window = matchingWindow(targetFrame: frame, among: windows) else {
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
    /// `AXWindows` alone comes back empty for a process whose windows are all on another Space, which
    /// is precisely the case this feature must not miss; `AXFocusedWindow` and `AXMainWindow` still
    /// answer in that state, so the union is what actually describes the application.
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

    /// Correlates the audited `CGWindowID`'s frame to an `AXUIElement`.
    ///
    /// The Accessibility API exposes no window id, so the only shared fact between the two views is the
    /// frame. A single window needs no disambiguation; several windows require an unambiguous frame
    /// match, because typing a prompt into the wrong conversation is worse than reporting the window
    /// missing.
    private func matchingWindow(targetFrame: CGRect, among windows: [AXUIElement]) -> AXUIElement? {
        if windows.count == 1 { return windows[0] }
        let matches = windows.filter { window in
            guard let windowFrame = frame(of: window) else { return false }
            return abs(windowFrame.origin.x - targetFrame.origin.x) < 2
                && abs(windowFrame.origin.y - targetFrame.origin.y) < 2
                && abs(windowFrame.size.width - targetFrame.size.width) < 2
                && abs(windowFrame.size.height - targetFrame.size.height) < 2
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// Finds the prompt composer by role AND description together, never "the first text area found".
    private func findComposer(in element: AXUIElement, depth: Int, visited: inout Set<UInt>) -> AXUIElement? {
        guard depth < Self.maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if string(element, kAXRoleAttribute) == kAXTextAreaRole,
           string(element, kAXDescriptionAttribute) == Config.codexComposerDescription {
            return element
        }
        for child in childElements(of: element) {
            if let found = findComposer(in: child, depth: depth + 1, visited: &visited) { return found }
        }
        return nil
    }

    // MARK: - Attribute helpers

    private func string(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return "" }
        return value as? String ?? ""
    }

    private func childElements(of element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let children = raw as? [AXUIElement]
        else { return [] }
        return children
    }

    private func frame(of element: AXUIElement) -> CGRect? {
        guard let position = point(element, kAXPositionAttribute),
              let windowSize = size(element, kAXSizeAttribute)
        else { return nil }
        return CGRect(origin: position, size: windowSize)
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

    /// The first descendant matching `matching`, depth-first with a cycle guard.
    private func firstDescendant(
        in element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>,
        matching: (AXUIElement) -> Bool
    ) -> AXUIElement? {
        guard depth < Self.maxSearchDepth, visited.insert(CFHash(element)).inserted else { return nil }
        if matching(element) { return element }
        for child in childElements(of: element) {
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
}
