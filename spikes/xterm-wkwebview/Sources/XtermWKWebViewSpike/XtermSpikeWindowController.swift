import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalSession
import WebKit

@MainActor
final class XtermSpikeWindowController: NSWindowController, WKNavigationDelegate, WKScriptMessageHandler {
    private final class SessionHandle {
        let connection: PtySessionConnection
        let renderer: WebTerminalRenderer
        let driver: PtyTerminalSessionDriver
        var dimensions: PtyTerminalDimensions

        init(
            connection: PtySessionConnection,
            renderer: WebTerminalRenderer,
            driver: PtyTerminalSessionDriver,
            dimensions: PtyTerminalDimensions
        ) {
            self.connection = connection
            self.renderer = renderer
            self.driver = driver
            self.dimensions = dimensions
        }
    }

    private static let maximumPendingJavaScriptCalls = 512
    private let configuration: SpikeConfiguration
    private let foregroundPIDAtLaunch: pid_t?
    private let webView: WKWebView
    private var sessions: [String: SessionHandle] = [:]
    private var synchronizedSessionIDs: Set<String> = []
    private var didStartSessions = false
    private var didSeedFixtures = false
    private var didRunBackgroundSelfTest = false
    private var pendingJavaScript: [String] = []
    private var isEvaluatingJavaScript = false

    init(configuration: SpikeConfiguration, foregroundPIDAtLaunch: pid_t?) {
        self.configuration = configuration
        self.foregroundPIDAtLaunch = foregroundPIDAtLaunch
        let contentController = WKUserContentController()
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.userContentController = contentController
        webConfiguration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: webConfiguration)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init(window: window)

        window.title = "xterm.js WKWebView Spike"
        window.center()
        window.setAccessibilityIdentifier("xterm-wkwebview-spike-window")
        window.contentView = webView
        webView.setAccessibilityIdentifier("xterm-wkwebview-spike-webview")
        webView.navigationDelegate = self
        contentController.add(WeakScriptMessageHandler(target: self), name: "terminalSpike")
        loadWebRuntime()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("XtermSpikeWindowController does not support Interface Builder")
    }

    func showWithoutActivating() {
        window?.orderFrontRegardless()
    }

    func shutdown() {
        let handles = sessions.values
        sessions.removeAll()
        for handle in handles {
            handle.driver.stop()
            Task { try? await handle.connection.detach() }
        }
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "terminalSpike")
    }

    func deliver(_ message: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8) else {
            fatalError("xterm spike generated an invalid JavaScript message")
        }
        guard pendingJavaScript.count < Self.maximumPendingJavaScriptCalls else {
            fatalError("xterm spike native-to-web bridge exceeded its bounded call queue")
        }
        pendingJavaScript.append("window.agentDeskTerminal.receive(\(json))")
        evaluateNextJavaScriptCall()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "terminalSpike", let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }
        switch type {
        case "ready":
            guard let dimensions = dimensions(from: body), !didStartSessions else { return }
            didStartSessions = true
            startSessions(initialDimensions: dimensions)
        case "viewport":
            handleViewport(body)
        case "input":
            guard let terminalID = body["terminalId"] as? String,
                  let text = body["data"] as? String else { return }
            sendInput(Data(text.utf8), to: terminalID)
        case "input-base64":
            guard let terminalID = body["terminalId"] as? String,
                  let encoded = body["data"] as? String,
                  let data = Data(base64Encoded: encoded) else { return }
            sendInput(data, to: terminalID)
        case "log":
            if let text = body["message"] as? String {
                print("xterm-spike web: \(text)")
            }
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fatalError("xterm spike web navigation failed: \(error)")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        fatalError("xterm spike web navigation failed: \(error)")
    }

    private func loadWebRuntime() {
        guard let root = Bundle.module.resourceURL?.appendingPathComponent("Web", isDirectory: true),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("app.js").path) else {
            fatalError("Run npm run build in spikes/xterm-wkwebview before launching the Swift spike")
        }
        webView.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
    }

    private func startSessions(initialDimensions: PtyTerminalDimensions) {
        let client = PtyClient(socketPath: configuration.socketPath)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.openSession(
                    terminalID: "tab-a",
                    sessionSuffix: "a",
                    initialDimensions: initialDimensions,
                    client: client
                )
                try await self.openSession(
                    terminalID: "tab-b",
                    sessionSuffix: "b",
                    initialDimensions: initialDimensions,
                    client: client
                )
                self.deliver(["type": "native-ready"])
            } catch {
                self.deliver([
                    "type": "status",
                    "terminalId": "tab-a",
                    "text": "Native bridge failed: \(error)",
                ])
            }
        }
    }

    func rendererDidSynchronize(terminalID: String) {
        synchronizedSessionIDs.insert(terminalID)
        guard !didSeedFixtures, synchronizedSessionIDs.count == 2 else { return }
        didSeedFixtures = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 750_000_000)
            guard let self else { return }
            self.seedFixtures()
            guard self.configuration.runsBackgroundSelfTest else { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            await self.runBackgroundSelfTest()
        }
    }

    private func runBackgroundSelfTest() async {
        guard !didRunBackgroundSelfTest, let handle = sessions["tab-a"] else { return }
        didRunBackgroundSelfTest = true
        let marker = "SPIKE_BACKGROUND_OK"
        handle.driver.sendInput(
            Data("printf 'SPIKE_BACKGROUND_OK\\n'\r".utf8),
            viewerDimensions: handle.dimensions
        )
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let before = await terminalSnapshot(terminalID: "tab-a", marker: marker)

        window?.setContentSize(NSSize(width: 780, height: 460))
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let after = await terminalSnapshot(terminalID: "tab-a", marker: marker)
        let foregroundPIDAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let result: [String: Any] = [
            "focusPreserved": foregroundPIDAtLaunch != nil && foregroundPIDAtLaunch == foregroundPIDAfter,
            "markerBeforeResize": before?.containsMarker ?? false,
            "markerAfterResize": after?.containsMarker ?? false,
            "columnsBeforeResize": before?.columns ?? 0,
            "rowsBeforeResize": before?.rows ?? 0,
            "columnsAfterResize": after?.columns ?? 0,
            "rowsAfterResize": after?.rows ?? 0,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            fatalError("xterm spike could not encode its background self-test result")
        }
        print("xterm-spike self-test \(json)")
        fflush(stdout)
        NSApp.terminate(nil)
    }

    private func terminalSnapshot(terminalID: String, marker: String) async -> TerminalSnapshot? {
        let script = "window.agentDeskTerminal.snapshot(\(javaScriptString(terminalID)), \(javaScriptString(marker)))"
        return await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                MainActor.assumeIsolated {
                    guard error == nil, let dictionary = value as? [String: Any],
                          let containsMarker = dictionary["containsMarker"] as? Bool,
                          let columns = dictionary["columns"] as? NSNumber,
                          let rows = dictionary["rows"] as? NSNumber else {
                        continuation.resume(returning: nil)
                        return
                    }
                    continuation.resume(returning: TerminalSnapshot(
                        containsMarker: containsMarker,
                        columns: columns.uint32Value,
                        rows: rows.uint32Value
                    ))
                }
            }
        }
    }

    private func javaScriptString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8) else {
            fatalError("xterm spike could not encode a JavaScript string")
        }
        return String(array.dropFirst().dropLast())
    }

    private func openSession(
        terminalID: String,
        sessionSuffix: String,
        initialDimensions: PtyTerminalDimensions,
        client: PtyClient
    ) async throws {
        let sessionName = "xterm-spike-\(ProcessInfo.processInfo.processIdentifier)-\(sessionSuffix)"
        let connection = try await client.openSession(
            name: sessionName,
            launch: .shell(cwd: configuration.workingDirectory, shell: "/bin/zsh"),
            lifetime: .leased,
            columns: initialDimensions.columns,
            rows: initialDimensions.rows,
            clientTitle: "xterm.js WKWebView \(sessionSuffix.uppercased())"
        )
        let renderer = WebTerminalRenderer(terminalID: terminalID, controller: self)
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onTermination: { [weak self] termination in
                self?.deliver([
                    "type": "status",
                    "terminalId": terminalID,
                    "text": "Session terminated: \(termination)",
                ])
            },
            onError: { [weak self] error in
                self?.deliver([
                    "type": "status",
                    "terminalId": terminalID,
                    "text": "Protocol error: \(error)",
                ])
            }
        )
        sessions[terminalID] = SessionHandle(
            connection: connection,
            renderer: renderer,
            driver: driver,
            dimensions: initialDimensions
        )
        driver.start()
    }

    private func seedFixtures() {
        let fixtures = [
            "tab-a": "printf '\\033[36;1mxterm.js tab A\\033[0m  ✓ Unicode: 日本語 λ 🚀\\n'; pwd",
            "tab-b": "printf '\\033[35;1mxterm.js tab B\\033[0m  ✓ independent PTY session\\n'; printf 'Resize and switch tabs, then run vim if wanted.\\n'",
        ]
        for (terminalID, command) in fixtures {
            guard let handle = sessions[terminalID] else { continue }
            handle.driver.sendInput(Data("\(command)\r".utf8), viewerDimensions: handle.dimensions)
        }
    }

    private func handleViewport(_ body: [String: Any]) {
        guard let terminalID = body["terminalId"] as? String,
              let handle = sessions[terminalID],
              let dimensions = dimensions(from: body),
              let active = body["active"] as? Bool,
              let claim = body["claim"] as? Bool else { return }
        handle.dimensions = dimensions
        handle.driver.updateViewerState(active: active, claim: claim, dimensions: dimensions)
    }

    private func sendInput(_ data: Data, to terminalID: String) {
        guard let handle = sessions[terminalID] else { return }
        handle.driver.sendInput(data, viewerDimensions: handle.dimensions)
    }

    private func dimensions(from body: [String: Any]) -> PtyTerminalDimensions? {
        guard let columnNumber = body["columns"] as? NSNumber,
              let rowNumber = body["rows"] as? NSNumber else { return nil }
        let columns = columnNumber.uint32Value
        let rows = rowNumber.uint32Value
        guard (1...512).contains(columns), (1...256).contains(rows) else { return nil }
        return PtyTerminalDimensions(columns: columns, rows: rows)
    }

    private func evaluateNextJavaScriptCall() {
        guard !isEvaluatingJavaScript, !pendingJavaScript.isEmpty else { return }
        isEvaluatingJavaScript = true
        let script = pendingJavaScript.removeFirst()
        webView.evaluateJavaScript(script) { [weak self] _, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.isEvaluatingJavaScript = false
                if let error {
                    fatalError("xterm spike native-to-web bridge failed: \(error)")
                }
                self.evaluateNextJavaScriptCall()
            }
        }
    }
}

private struct TerminalSnapshot {
    let containsMarker: Bool
    let columns: UInt32
    let rows: UInt32
}
