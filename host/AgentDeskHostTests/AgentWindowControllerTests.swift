import AppKit
import AgentPanel
import ApplicationServices
import PtyTerminalSwiftTerm
import Testing
import WebKit

@testable import AgentDeskHost

// R24 accessibility verification. Rather than a screenshot (blocked by the shell-context TCC screen
// capture grant), these assert the Agents window and its content surface through the AppKit
// accessibility API — the same identifiers an AX/Maestro driver or VoiceOver would resolve. The
// window is AX-identified as `agentdesk-agents-window`; its content surface carries either the live
// webview's `agents-webview` id or, if the bundled panel assets fail to resolve, the fallback's
// `agents-unavailable` id — so the surface is always AX-reachable.
@MainActor
@Suite(.serialized)
struct AgentWindowControllerTests {
    /// Collects the non-empty accessibility identifiers of a view subtree.
    private func axIdentifiers(in view: NSView?) -> Set<String> {
        guard let view else { return [] }
        var result: Set<String> = []
        let identifier = view.accessibilityIdentifier()
        if !identifier.isEmpty { result.insert(identifier) }
        for subview in view.subviews {
            result.formUnion(axIdentifiers(in: subview))
        }
        return result
    }

    private func webView(in view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let webView = view as? WKWebView { return webView }
        for subview in view.subviews {
            if let webView = webView(in: subview) { return webView }
        }
        return nil
    }

    @Test func showBuildsAnAccessibilityIdentifiedAgentsWindow() throws {
        let controller = AgentWindowController(sidecarClient: FakeSidecarClient())
        controller.show()

        let window = try #require(controller.windowForTesting)
        #expect(window.title == "Agents")
        #expect(window.identifier?.rawValue == AgentWindowController.windowIdentifier)
        #expect(window.accessibilityIdentifier() == AgentWindowController.windowIdentifier)

        // The content surface is AX-reachable as either the live webview or the fallback label.
        let ids = axIdentifiers(in: window.contentView)
        #expect(
            ids.contains(AgentWindowController.webViewAccessibilityIdentifier)
            || ids.contains(AgentWindowController.unavailableAccessibilityIdentifier)
        )
    }

    @Test func toggleWaitsForCloseThenReusesFeedWithoutRestoringTerminal() async throws {
        let terminal = FakeAgentWindowTerminalController()
        terminal.suspendClose = true
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()
        let first = try #require(controller.windowForTesting)

        // A toggle hides-or-shows but must never construct a second window: the surface (and its
        // in-flight feed) is preserved across visibility changes.
        controller.toggle()
        #expect(first.isVisible)
        #expect(terminal.closeReasons == [.windowHidden])

        #expect(controller.windowShouldClose(first) == false)
        #expect(first.isVisible)
        #expect(terminal.closeReasons == [.windowHidden])

        terminal.resumeClose()
        try await waitUntil { !first.isVisible }
        controller.toggle()
        #expect(controller.windowForTesting === first)
        #expect(first.isVisible)
        #expect(terminal.closeReasons == [.windowHidden])
        #expect(terminal.handledIntents.isEmpty)
    }

    @Test func windowShouldCloseWaitsForCloseCommitBeforeHiding() async throws {
        let terminal = FakeAgentWindowTerminalController()
        terminal.suspendClose = true
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()
        let window = try #require(controller.windowForTesting)

        #expect(controller.windowShouldClose(window) == false)
        #expect(window.isVisible)
        #expect(terminal.closeReasons == [.windowShouldClose])
        #expect(controller.windowForTesting === window)

        terminal.resumeClose()
        try await waitUntil { !window.isVisible }
        #expect(controller.windowForTesting === window)
    }

    @Test func stopAwaitsTerminalCloseAndTearsDownTheWindow() async {
        let terminal = FakeAgentWindowTerminalController()
        terminal.suspendClose = true
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()
        #expect(controller.windowForTesting != nil)

        let stop = controller.beginStop()
        await Task.yield()
        #expect(terminal.closeReasons == [.appTermination])
        #expect(controller.windowForTesting != nil)

        terminal.resumeClose()
        await stop.value
        #expect(controller.windowForTesting == nil)
    }

    @Test func panelAndNativeTerminalControlsExposeStableAccessibilityIdentifiers() throws {
        let terminal = FakeAgentWindowTerminalController()
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()

        let window = try #require(controller.windowForTesting)
        let panel = try #require(webView(in: window.contentView))

        #expect(panel.configuration.userContentController.userScripts.contains {
            $0.injectionTime == .atDocumentStart
        })
        #expect(
            terminal.terminalView.accessibilityIdentifier()
                == AgentWindowAccessibilityIdentifiers.terminalContent
        )
    }

    @Test func nativeTerminalIdentifiersReachExternalAccessibilityClients() async throws {
        let split = AgentWindowSplitView(
            feedView: NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 320)),
            terminalView: PtyTerminalSwiftTermContentView()
        )
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 320)
        split.setTerminalOpen(true)
        split.layoutSubtreeIfNeeded()

        let window = NSWindow(
            contentRect: split.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "R73 native terminal accessibility test"
        window.contentView = split
        window.orderFront(nil)
        defer { window.orderOut(nil) }

        guard nativeWindowAccessibilityIsExternallyVendored() else { return }
        try await waitForAccessibilityIdentifier(
            AgentWindowAccessibilityIdentifiers.terminalSplitter,
            in: window
        )
        try await waitForAccessibilityIdentifier(
            AgentWindowAccessibilityIdentifiers.terminalContent,
            in: window
        )
    }

    @Test func terminalAccessibilityScriptIdentifiesDynamicWebStates() async throws {
        let contentController = WKUserContentController()
        contentController.addUserScript(AgentWindowPanelAccessibility.userScript)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        let webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 480, height: 240),
            configuration: configuration
        )
        let window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "R68 terminal accessibility test"
        window.contentView = webView
        window.orderFront(nil)
        defer { window.orderOut(nil) }

        webView.loadHTMLString(
            "<html><body><footer><button aria-label=\"Open Codex terminal\">Open</button></footer></body></html>",
            baseURL: nil
        )
        try await waitForDOMIdentifier(
            AgentWindowAccessibilityIdentifiers.terminalLauncher,
            in: webView
        )
        #expect(try await elementID(for: "button", in: webView)
            == AgentWindowAccessibilityIdentifiers.terminalLauncher)
        let exposesAccessibilityDOMIdentifiers = try await accessibilityDOMIdentifierIsAvailable(
            AgentWindowAccessibilityIdentifiers.terminalLauncher,
            in: window
        )

        try await replaceFooter(
            with: "<span role=\"status\">Opening terminal</span>",
            in: webView
        )
        try await waitForDOMIdentifier(
            AgentWindowAccessibilityIdentifiers.terminalStatus,
            in: webView
        )
        #expect(try await elementID(for: "[role=status]", in: webView)
            == AgentWindowAccessibilityIdentifiers.terminalStatus)
        if exposesAccessibilityDOMIdentifiers {
            try await waitForAccessibilityDOMIdentifier(
                AgentWindowAccessibilityIdentifiers.terminalStatus,
                in: window
            )
        }

        try await replaceFooter(
            with: "<button aria-label=\"Close Codex terminal\">Close</button>",
            in: webView
        )
        try await waitForDOMIdentifier(
            AgentWindowAccessibilityIdentifiers.terminalClose,
            in: webView
        )
        #expect(try await elementID(for: "button", in: webView)
            == AgentWindowAccessibilityIdentifiers.terminalClose)
        if exposesAccessibilityDOMIdentifiers {
            try await waitForAccessibilityDOMIdentifier(
                AgentWindowAccessibilityIdentifiers.terminalClose,
                in: window
            )
        }
    }

    @Test func panelAccessibilityScriptIdentifiesProjectAndSessionRows() async throws {
        let contentController = WKUserContentController()
        contentController.addUserScript(AgentWindowPanelAccessibility.userScript)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        let webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 480, height: 320),
            configuration: configuration
        )
        let window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "R72 panel row accessibility test"
        window.contentView = webView
        window.orderFront(nil)
        defer { window.orderOut(nil) }

        webView.loadHTMLString(
            """
            <html><body>
              <header><button aria-label="Go back">Back</button></header>
              <ul aria-label="Projects">
                <li><button><span>Alpha Project</span></button></li>
              </ul>
              <ul aria-label="Sessions">
                <li>
                  <button>
                    <span aria-label="Source: Claude">Claude</span>
                    <p>Debug cloud FinOps notifications firing issue</p>
                    <p>01:05 AM</p>
                  </button>
                </li>
              </ul>
            </body></html>
            """,
            baseURL: nil
        )

        try await waitForDOMIdentifier(AgentPanelAccessibilityIdentifiers.backButton, in: webView)
        let projectID = "\(AgentPanelAccessibilityIdentifiers.projectRowPrefix)alpha-project"
        let sessionID =
            "\(AgentPanelAccessibilityIdentifiers.sessionRowPrefix)claude-debug-cloud-finops-notifications-firing-issue"
        try await waitForDOMIdentifier(projectID, in: webView)
        try await waitForDOMIdentifier(sessionID, in: webView)
        #expect(try await elementID(for: "button[aria-label='Go back']", in: webView)
            == AgentPanelAccessibilityIdentifiers.backButton)
        #expect(try await elementID(for: "ul[aria-label='Projects'] button", in: webView) == projectID)
        #expect(try await elementID(for: "ul[aria-label='Sessions'] button", in: webView) == sessionID)

        let exposesAccessibilityDOMIdentifiers = try await accessibilityDOMIdentifierIsAvailable(
            sessionID,
            in: window
        )
        if exposesAccessibilityDOMIdentifiers {
            try await waitForAccessibilityDOMIdentifier(
                AgentPanelAccessibilityIdentifiers.backButton,
                in: window
            )
            try await waitForAccessibilityDOMIdentifier(projectID, in: window)
            try await waitForAccessibilityDOMIdentifier(sessionID, in: window)
        }
    }

    @Test func appTerminationWaitsUntilTheAgentWindowHasNoTerminal() async {
        let terminal = FakeAgentWindowTerminalController()
        terminal.suspendClose = true
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()
        let lifecycle = AgentWindowApplicationLifecycle()
        var stopCalls = 0

        let termination = lifecycle.beginStop {
            stopCalls += 1
            return controller.beginStop()
        }
        let repeatedTermination = lifecycle.beginStop {
            stopCalls += 1
            return controller.beginStop()
        }
        #expect(terminal.closeReasons == [.appTermination])
        #expect(stopCalls == 1)
        #expect(controller.windowForTesting != nil)

        terminal.resumeClose()
        await termination.value
        await repeatedTermination.value
        #expect(stopCalls == 1)
        #expect(controller.windowForTesting == nil)
    }

    private func waitUntil(
        _ condition: @MainActor @escaping () -> Bool
    ) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out waiting for Agent window lifecycle condition")
    }

    private func replaceFooter(with markup: String, in webView: WKWebView) async throws {
        _ = try await webView.callAsyncJavaScript(
            "document.querySelector('footer').innerHTML = markup; return true;",
            arguments: ["markup": markup],
            in: nil,
            contentWorld: .page
        )
    }

    private func elementID(for selector: String, in webView: WKWebView) async throws -> String? {
        try await webView.callAsyncJavaScript(
            "return document.querySelector(selector)?.id || null;",
            arguments: ["selector": selector],
            in: nil,
            contentWorld: .page
        ) as? String
    }

    private func waitForDOMIdentifier(_ identifier: String, in webView: WKWebView) async throws {
        for _ in 0..<200 {
            do {
                let installed = try await webView.callAsyncJavaScript(
                    "return document.getElementById(identifier) !== null;",
                    arguments: ["identifier": identifier],
                    in: nil,
                    contentWorld: .page
                ) as? Bool
                if installed == true { return }
            } catch {
                // Navigation may not have committed yet.
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out waiting for terminal DOM identifier \(identifier)")
    }

    private func waitForAccessibilityDOMIdentifier(
        _ identifier: String,
        in window: NSWindow
    ) async throws {
        for _ in 0..<200 {
            if accessibilityDOMIdentifiers(in: window).contains(identifier) { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out waiting for WebKit AX DOM identifier \(identifier)")
    }

    private func waitForAccessibilityIdentifier(
        _ identifier: String,
        in window: NSWindow
    ) async throws {
        for _ in 0..<200 {
            if accessibilityIdentifiers(in: window).contains(identifier) { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        let visible = accessibilityIdentifiers(in: window).sorted().joined(separator: ", ")
        Issue.record("Timed out waiting for native AX identifier \(identifier); visible ids: [\(visible)]")
    }

    private func accessibilityDOMIdentifierIsAvailable(
        _ identifier: String,
        in window: NSWindow
    ) async throws -> Bool {
        for _ in 0..<20 {
            if accessibilityDOMIdentifiers(in: window).contains(identifier) { return true }
            try await Task.sleep(for: .milliseconds(5))
        }
        return false
    }

    private func accessibilityDOMIdentifiers(in window: NSWindow) -> Set<String> {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.05)
        return collectAccessibilityStrings(
            attribute: kAXDOMIdentifierAttribute as String,
            from: application
        )
    }

    private func accessibilityIdentifiers(in window: NSWindow) -> Set<String> {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.05)
        return collectAccessibilityStrings(
            attribute: kAXIdentifierAttribute as String,
            from: application
        )
    }

    private func nativeWindowAccessibilityIsExternallyVendored() -> Bool {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.05)
        return !collectAccessibilityWindows(from: application).isEmpty
    }

    private func axValues(_ element: AXUIElement, attribute: String) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? [AXUIElement]
    }

    private func axString(_ element: AXUIElement, attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }

    private func collectAccessibilityStrings(
        attribute: String,
        from root: AXUIElement
    ) -> Set<String> {
        var visited: Set<UInt> = []
        return collectAccessibilityStrings(
            attribute: attribute,
            from: root,
            depth: 0,
            visited: &visited
        )
    }

    private func collectAccessibilityStrings(
        attribute: String,
        from element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>
    ) -> Set<String> {
        let hash = CFHash(element)
        guard visited.insert(hash).inserted, depth < 32 else { return [] }
        AXUIElementSetMessagingTimeout(element, 0.05)

        var result: Set<String> = []
        if let value = axString(element, attribute: attribute), !value.isEmpty {
            result.insert(value)
        }
        for related in relatedAccessibilityElements(for: element) {
            result.formUnion(
                collectAccessibilityStrings(
                    attribute: attribute,
                    from: related,
                    depth: depth + 1,
                    visited: &visited
                )
            )
        }
        return result
    }

    private func relatedAccessibilityElements(for element: AXUIElement) -> [AXUIElement] {
        let role = axString(element, attribute: kAXRoleAttribute as String)
        var related = axValues(element, attribute: kAXChildrenAttribute) ?? []
        related.append(contentsOf: axValues(element, attribute: "AXChildrenInNavigationOrder") ?? [])

        if role == kAXApplicationRole {
            related.append(contentsOf: axValues(element, attribute: kAXWindowsAttribute as String) ?? [])
            related.append(contentsOf: axValues(element, attribute: "AXFunctionRowTopLevelElements") ?? [])
            if let focusedWindow = axValue(element, attribute: kAXFocusedWindowAttribute as String) {
                related.append(focusedWindow)
            }
            if let mainWindow = axValue(element, attribute: kAXMainWindowAttribute as String) {
                related.append(mainWindow)
            }
            if let menuBar = axValue(element, attribute: kAXMenuBarAttribute as String) {
                related.append(menuBar)
            }
            if let extrasMenuBar = axValue(element, attribute: "AXExtrasMenuBar") {
                related.append(extrasMenuBar)
            }
            if let focusedElement = axValue(element, attribute: kAXFocusedUIElementAttribute as String) {
                related.append(focusedElement)
            }
        }

        var seen: Set<UInt> = []
        return related.filter { seen.insert(CFHash($0)).inserted }
    }

    private func collectAccessibilityWindows(from root: AXUIElement) -> [AXUIElement] {
        var visited: Set<UInt> = []
        return collectAccessibilityWindows(from: root, depth: 0, visited: &visited)
    }

    private func collectAccessibilityWindows(
        from element: AXUIElement,
        depth: Int,
        visited: inout Set<UInt>
    ) -> [AXUIElement] {
        let hash = CFHash(element)
        guard visited.insert(hash).inserted, depth < 32 else { return [] }

        var result: [AXUIElement] = []
        if axString(element, attribute: kAXRoleAttribute as String) == kAXWindowRole {
            result.append(element)
        }
        for related in relatedAccessibilityElements(for: element) {
            result.append(contentsOf: collectAccessibilityWindows(
                from: related,
                depth: depth + 1,
                visited: &visited
            ))
        }
        return result
    }

    private func axValue(_ element: AXUIElement, attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        guard let value else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
}

@MainActor
private final class FakeAgentWindowTerminalController: AgentWindowTerminalControlling {
    let terminalView = NSView()
    var handledIntents: [AgentPanelTerminalIntent] = []
    var closeReasons: [AgentWindowTerminalExplicitCloseReason] = []
    var suspendClose = false

    private var closeTask: Task<Void, Never>?
    private var closeContinuation: CheckedContinuation<Void, Never>?
    private var closeWasResumed = false

    func handle(_ intent: AgentPanelTerminalIntent) {
        handledIntents.append(intent)
    }

    func beginExplicitClose(
        reason: AgentWindowTerminalExplicitCloseReason
    ) -> Task<Void, Never>? {
        if let closeTask { return closeTask }
        closeReasons.append(reason)
        guard suspendClose else { return nil }
        let task = Task { [weak self] in
            await withCheckedContinuation { continuation in
                guard let self else {
                    continuation.resume()
                    return
                }
                if self.closeWasResumed {
                    continuation.resume()
                } else {
                    self.closeContinuation = continuation
                }
            }
        }
        closeTask = task
        return task
    }

    func resumeClose() {
        if let closeContinuation {
            closeContinuation.resume()
            self.closeContinuation = nil
        } else {
            closeWasResumed = true
        }
    }
}
