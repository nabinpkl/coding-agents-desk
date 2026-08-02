import XCTest
@testable import PtyTerminalWebView

final class PtyTerminalWebBridgeTests: XCTestCase {
    @MainActor
    func testNativeProxyFocusRequestsNativeInputWithoutRerendering() throws {
        let view = PtyTerminalWebView(profile: .workspace, inputMode: .nativeProxy)
        defer { view.teardown() }
        view.webView.stopLoading()
        let delegate = FocusDelegate()
        view.delegate = delegate
        let pane = try XCTUnwrap(view.workspaceState.selectedPane)
        view.deliveryQueue.removeAll()

        view.handle(.focus(paneID: pane.paneID, claim: true))

        XCTAssertEqual(delegate.focusRequestCount, 1)
        XCTAssertTrue(view.deliveryQueue.deliveries.isEmpty)
    }

    @MainActor
    func testNativeKeyDeliveryIsBoundedAndTargetsSelectedTerminal() throws {
        let view = PtyTerminalWebView(profile: .workspace, inputMode: .nativeProxy)
        defer { view.teardown() }
        view.webView.stopLoading()
        let pane = try XCTUnwrap(view.workspaceState.selectedPane)
        view.slots[pane.terminalID] = PtyTerminalWebView.Slot(
            paneID: pane.paneID,
            terminalID: pane.terminalID,
            owner: view
        )
        view.deliveryQueue.removeAll()

        view.sendKey(code: "ansi-C", modifiers: [.control])
        view.sendKey(code: String(repeating: "x", count: 100), modifiers: [])

        let delivery = try XCTUnwrap(view.deliveryQueue.deliveries.first)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(delivery.json.utf8)) as? [String: Any]
        )
        XCTAssertEqual(view.deliveryQueue.deliveries.count, 1)
        XCTAssertEqual(object["type"] as? String, "keyInput")
        XCTAssertEqual(object["terminalId"] as? String, pane.terminalID)
        XCTAssertEqual(object["code"] as? String, "ansi-C")
        XCTAssertEqual(object["modifiers"] as? [String], ["control"])
    }

    @MainActor
    func testPaneFocusDoesNotQueueAWorkspaceRerender() throws {
        let view = PtyTerminalWebView(profile: .workspace)
        defer { view.teardown() }
        view.webView.stopLoading()
        let second = try XCTUnwrap(view.workspaceState.splitFocusedPane(axis: .vertical))
        let first = try XCTUnwrap(view.workspaceState.panes.first { $0.paneID != second.paneID })
        view.deliveryQueue.removeAll()

        view.handle(.focus(paneID: first.paneID, claim: true))

        XCTAssertEqual(view.workspaceState.selectedPane?.paneID, first.paneID)
        XCTAssertTrue(view.deliveryQueue.deliveries.isEmpty)
    }

    @MainActor
    func testSelectedLiveOutputAdvancesPublicAppliedRevision() throws {
        let view = PtyTerminalWebView(profile: .workspace)
        defer { view.teardown() }
        let pane = try XCTUnwrap(view.workspaceState.selectedPane)
        view.slots[pane.terminalID] = PtyTerminalWebView.Slot(
            paneID: pane.paneID,
            terminalID: pane.terminalID,
            owner: view
        )

        view.deliverData(
            type: "output",
            data: Data("live".utf8),
            terminalID: pane.terminalID,
            revision: 7,
            liveOutput: true
        )

        XCTAssertEqual(view.appliedRevision, 7)
        XCTAssertEqual(view.slots[pane.terminalID]?.revision, 7)
    }

    func testStartupMessagesDecodeNSNumberVersionsFromWebKit() {
        XCTAssertEqual(
            PtyTerminalWebIntent.decode([
                "version": NSNumber(value: 1),
                "type": "booted",
            ]),
            .booted
        )
        XCTAssertEqual(
            PtyTerminalWebIntent.decode([
                "version": NSNumber(value: 1),
                "type": "fontReady",
            ]),
            .fontReady
        )
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": NSNumber(value: true),
            "type": "booted",
        ]))
    }

    func testBundledRuntimeResourceRootExists() throws {
        let root = try XCTUnwrap(PtyTerminalResourceSchemeHandler.bundledRoot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("app.js").path))
    }

    func testViewportRequiresBoundsAndActiveClaim() {
        XCTAssertEqual(
            PtyTerminalWebIntent.decode([
                "version": 1, "type": "viewport", "terminalId": "terminal-1",
                "active": true, "claim": true, "columns": 120, "rows": 40,
            ]),
            .viewport(terminalID: "terminal-1", active: true, claim: true, columns: 120, rows: 40)
        )
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": 1, "type": "viewport", "terminalId": "terminal-1",
            "active": false, "claim": true, "columns": 120, "rows": 40,
        ]))
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": 1, "type": "viewport", "terminalId": "terminal-1",
            "active": true, "claim": false, "columns": 513, "rows": 40,
        ]))
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": 1, "type": "viewport", "terminalId": "terminal-1",
            "active": true, "claim": false, "columns": 80.5, "rows": 40,
        ]))
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": 1.5, "type": "ready",
        ]))
    }

    @MainActor
    func testUnsettledViewportCannotReplaceAuthorityDimensions() throws {
        let view = PtyTerminalWebView()
        defer { view.teardown() }
        let pane = try XCTUnwrap(view.workspaceState.selectedPane)
        let slot = PtyTerminalWebView.Slot(
            paneID: pane.paneID,
            terminalID: pane.terminalID,
            owner: view
        )
        view.slots[pane.terminalID] = slot
        view.setViewportActive(true, claim: true)

        view.handle(.viewport(
            terminalID: pane.terminalID,
            active: true,
            claim: true,
            columns: 127,
            rows: 1
        ))

        XCTAssertEqual(slot.dimensions, .bootstrap)
        XCTAssertFalse(slot.hasSettledViewportDimensions)
        XCTAssertEqual(view.pendingViewportClaimPaneID, pane.paneID)

        view.handle(.viewport(
            terminalID: pane.terminalID,
            active: true,
            claim: false,
            columns: 127,
            rows: 40
        ))

        XCTAssertEqual(slot.dimensions, .init(columns: 127, rows: 40))
        XCTAssertTrue(slot.hasSettledViewportDimensions)
        XCTAssertNil(view.pendingViewportClaimPaneID)
    }

    func testWorkspaceIntentRejectsPresentButInvalidOptionalFields() {
        XCTAssertEqual(
            PtyTerminalWebIntent.decode(["version": 1, "type": "workspaceIntent", "intent": "addTab"]),
            .workspace(name: "addTab", paneID: nil, tabID: nil, sessionName: nil)
        )
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": 1, "type": "workspaceIntent", "intent": "closePane",
            "paneId": String(repeating: "x", count: 129),
        ]))
        XCTAssertEqual(
            PtyTerminalWebIntent.decode([
                "version": 1, "type": "workspaceIntent", "intent": "closeTab", "tabId": "tab-1",
            ]),
            .workspace(name: "closeTab", paneID: nil, tabID: "tab-1", sessionName: nil)
        )
    }

    func testLinkPolicyAllowsOnlyHTTPAndHTTPS() {
        XCTAssertNotNil(PtyTerminalWebIntent.decode(["version": 1, "type": "openLink", "url": "https://example.com/"]))
        XCTAssertNil(PtyTerminalWebIntent.decode(["version": 1, "type": "openLink", "url": "file:///tmp/secret"]))
        XCTAssertNil(PtyTerminalWebIntent.decode(["version": 1, "type": "openLink", "url": "javascript:alert(1)"]))
    }

    func testPresentationMetricsAreBounded() {
        XCTAssertEqual(
            PtyTerminalWebIntent.decode([
                "version": 1, "type": "presentation", "terminalId": "terminal-1",
                "scale": 0.75, "cropped": true,
            ]),
            .presentation(terminalID: "terminal-1", scale: 0.75, cropped: true)
        )
        XCTAssertNil(PtyTerminalWebIntent.decode([
            "version": 1, "type": "presentation", "terminalId": "terminal-1",
            "scale": 1.1, "cropped": false,
        ]))
    }

    func testQueueBoundsLiveOutputPerTerminal() {
        var queue = PtyTerminalWebDeliveryQueue()
        XCTAssertTrue(queue.append(.init(terminalID: "one", json: "a", byteCount: 512 * 1024, liveOutput: true)))
        XCTAssertTrue(queue.append(.init(terminalID: "one", json: "b", byteCount: 512 * 1024, liveOutput: true)))
        XCTAssertFalse(queue.append(.init(terminalID: "one", json: "c", byteCount: 1, liveOutput: true)))
        XCTAssertTrue(queue.append(.init(terminalID: "two", json: "d", byteCount: 1, liveOutput: true)))
    }
}

@MainActor
private final class FocusDelegate: PtyTerminalWebViewDelegate {
    private(set) var focusRequestCount = 0

    func ptyTerminalContentDidRequestInputFocus(_ content: PtyTerminalWebView) {
        focusRequestCount += 1
    }
}
