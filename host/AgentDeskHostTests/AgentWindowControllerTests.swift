import AppKit
import AgentDeskWire
import AgentPanel
import PtyTerminalWebView
import Testing
import WebKit

@testable import AgentDeskHost

// R24 accessibility verification. These assert that the Agents window, its content surface, and the
// terminal split carry the identifiers an AX or Maestro driver resolves: the window is identified as
// `agentdesk-agents-window`, and its content surface carries either the live webview's
// `agents-webview` id or, when the bundled panel assets fail to resolve, the fallback's
// `agents-unavailable` id, so the surface is always identified.
//
// What these do NOT prove is that an external client can read those identifiers out of the process.
// That check used to live here, behind a guard on whether the test process vends its accessibility
// tree, and that guard is false on a developer machine: `xctest` has no bundle identity or TCC grant
// of its own, so nothing was vended and the assertions behind it never ran. The claim belongs to
// something driving the real bundled app, not to a unit suite that has to stay fast.
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
        let initialFrame = CGRect(x: 80, y: 120, width: 480, height: 720)
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            initialFrame: initialFrame
        )
        #expect(controller.windowForTesting == nil)

        controller.show()

        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        #expect(window.title == "Agents")
        #expect(window.identifier?.rawValue == AgentWindowController.windowIdentifier)
        #expect(window.accessibilityIdentifier() == AgentWindowController.windowIdentifier)
        #expect(window.frame == initialFrame)
        #expect(!window.collectionBehavior.contains(.canJoinAllSpaces))

        // The content surface is AX-reachable as either the live webview or the fallback label.
        let ids = axIdentifiers(in: window.contentView)
        #expect(
            ids.contains(AgentWindowController.webViewAccessibilityIdentifier)
            || ids.contains(AgentWindowController.unavailableAccessibilityIdentifier)
        )
    }

    @Test func closeWaitsForTerminalThenDiscardsTheWindowAndNotifiesItsOwner() async throws {
        let terminal = FakeAgentWindowTerminalController()
        terminal.suspendClose = true
        var closeCount = 0
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal,
            onClosed: { closeCount += 1 }
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()

        #expect(controller.windowShouldClose(window) == false)
        #expect(window.isVisible)
        #expect(terminal.closeReasons == [.windowShouldClose])
        #expect(closeCount == 0)
        terminal.resumeClose()
        try await waitUntil { controller.windowForTesting == nil }
        #expect(!window.isVisible)
        #expect(closeCount == 1)
    }

    @Test func stopDetachesTheTerminalWithoutEndingItAndTearsDownTheWindow() async {
        let terminal = FakeAgentWindowTerminalController()
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()
        controller.windowForTesting?.concealFromTheDesktopUnderTest()
        #expect(controller.windowForTesting != nil)

        await controller.beginStop().value

        // Quitting hands the PTY back rather than closing it: an explicit close would kill the
        // deterministic session the next launch resumes.
        #expect(terminal.preservingDetachCount == 1)
        #expect(terminal.closeReasons.isEmpty)
        #expect(controller.windowForTesting == nil)
    }

    @Test func resumingATerminalBuildsTheWindowAndReplaysTheStoredAttachment() {
        let terminal = FakeAgentWindowTerminalController()
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        let attachment = AgentWindowTerminalAttachment(
            requestID: "request-restored",
            context: AgentResumeTerminalContext(
                projectPath: "/Users/dev/project-a",
                source: "claude",
                harnessSessionID: "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
            ),
            ptySessionName: "agent-claude-a4cdd7b8"
        )

        controller.show(activating: false)
        controller.windowForTesting?.concealFromTheDesktopUnderTest()
        controller.resumeTerminal(attachment)

        #expect(terminal.resumed == [attachment])
    }

    @Test func panelAndNativeTerminalControlsExposeStableAccessibilityIdentifiers() throws {
        let terminal = FakeAgentWindowTerminalController()
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            terminalControllerForTesting: terminal
        )
        controller.show()

        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        let panel = try #require(webView(in: window.contentView))

        #expect(panel.configuration.userContentController.userScripts.contains {
            $0.injectionTime == .atDocumentStart
        })
        #expect(
            terminal.terminalView.accessibilityIdentifier()
                == AgentWindowAccessibilityIdentifiers.terminalContent
        )
    }

    @Test func nativeTerminalSplitExposesItsAccessibilityIdentifiers() throws {
        let split = AgentWindowSplitView(
            feedView: NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 320)),
            terminalView: PtyTerminalWebView()
        )
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 320)
        split.setTerminalOpen(true)
        split.layoutSubtreeIfNeeded()

        let ids = axIdentifiers(in: split)
        #expect(ids.contains(AgentWindowAccessibilityIdentifiers.terminalSplitter))
        #expect(ids.contains(AgentWindowAccessibilityIdentifiers.terminalContent))
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

}

/// Shared with `AgentWindowZoomTests`, hence not private.
@MainActor
final class FakeAgentWindowTerminalController: AgentWindowTerminalControlling {
    let terminalView = NSView()
    var handledIntents: [AgentPanelTerminalIntent] = []
    var closeReasons: [AgentWindowTerminalExplicitCloseReason] = []
    var suspendClose = false
    private(set) var preservingDetachCount = 0
    private(set) var resumed: [AgentWindowTerminalAttachment] = []
    private(set) var zoomScales: [Double] = []

    private var closeTask: Task<Void, Never>?
    private var closeContinuation: CheckedContinuation<Void, Never>?
    private var closeWasResumed = false
    private var attachmentObserver: ((AgentWindowTerminalAttachment?) -> Void)?

    func handle(_ intent: AgentPanelTerminalIntent) {
        handledIntents.append(intent)
    }

    func setZoomScale(_ scale: Double) {
        zoomScales.append(scale)
    }

    func observeAttachment(_ observer: @escaping (AgentWindowTerminalAttachment?) -> Void) {
        attachmentObserver = observer
    }

    func reportAttachment(_ attachment: AgentWindowTerminalAttachment?) {
        attachmentObserver?(attachment)
    }

    func beginPreservingDetach() {
        preservingDetachCount += 1
    }

    func resume(_ attachment: AgentWindowTerminalAttachment) {
        resumed.append(attachment)
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
