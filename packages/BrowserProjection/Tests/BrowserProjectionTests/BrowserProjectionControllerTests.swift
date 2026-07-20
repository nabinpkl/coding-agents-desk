import Foundation
import Testing
import WebKit
@testable import BrowserProjection

@MainActor
struct BrowserProjectionControllerTests {
    @Test func bundledReplayRuntimeHasOneDeliverEntrypoint() throws {
        let indexURL = try #require(BrowserProjectionResources.indexURL)
        let html = try String(contentsOf: indexURL, encoding: .utf8)

        #expect(html.contains("window.__browserProjectionDeliver"))
        #expect(html.contains("browser-projection-window-strip"))
        #expect(html.contains("browser-projection-tab-strip"))
        #expect(FileManager.default.fileExists(
            atPath: indexURL.deletingLastPathComponent().appendingPathComponent("rrweb.min.js").path
        ))
        #expect(FileManager.default.fileExists(
            atPath: indexURL.deletingLastPathComponent().appendingPathComponent("fflate.min.js").path
        ))
    }

    @Test func deliveryWaitsForTheReplayRuntimeThenPreservesOrder() {
        let controller = BrowserProjectionController(loadsRuntime: false)
        var scripts: [String] = []
        controller.evaluateScript = { scripts.append($0) }

        controller.deliver(rawJSON: #"{"t":"dom-batch","tb":1,"co":true,"ev":[]}"#)
        controller.deliver(rawJSON: #"{"t":"dom-batch","tb":1,"co":false,"ev":[]}"#)
        #expect(scripts.isEmpty)

        controller.markRuntimeLoaded()
        #expect(scripts.count == 2)
        #expect(scripts.allSatisfy { $0.hasPrefix("window.__browserProjectionDeliver(") })
        #expect(scripts[0].contains(#""co":true"#))
        #expect(scripts[1].contains(#""co":false"#))
    }

    @Test func teardownDropsQueuedAndFutureDelivery() {
        let controller = BrowserProjectionController(loadsRuntime: false)
        var scripts: [String] = []
        controller.evaluateScript = { scripts.append($0) }

        controller.deliver(rawJSON: #"{"t":"dom-batch","tb":1,"co":true,"ev":[]}"#)
        controller.teardown()
        controller.markRuntimeLoaded()
        controller.deliver(rawJSON: #"{"t":"dom-batch","tb":1,"co":false,"ev":[]}"#)

        #expect(scripts.isEmpty)
    }

    @Test func scriptMessagesExposeProjectionIntentsWithoutUIKit() {
        let controller = BrowserProjectionController(loadsRuntime: false)
        var taps: [(Double, Double)] = []
        var scrolls: [(Double, Double, Double, Double)] = []
        var windows: [(Int, Int)] = []
        var tabs: [(Int, Int, Int)] = []
        controller.onTap = { taps.append(($0, $1)) }
        controller.onScroll = { scrolls.append(($0, $1, $2, $3)) }
        controller.onSelectWindow = { windows.append(($0, $1)) }
        controller.onSelectTab = { tabs.append(($0, $1, $2)) }

        controller.handleScriptMessage(["kind": "tap", "x": 12, "y": 34])
        controller.handleScriptMessage(["kind": "scroll", "x": 1, "y": 2, "dx": 3, "dy": 4])
        controller.handleScriptMessage(["kind": "select-window", "windowId": 8, "generation": 9])
        controller.handleScriptMessage(["kind": "select-tab", "windowId": 8, "tabId": 10, "generation": 9])

        #expect(taps.count == 1)
        #expect(taps[0].0 == 12)
        #expect(taps[0].1 == 34)
        #expect(scrolls.count == 1)
        #expect(scrolls[0].0 == 1)
        #expect(scrolls[0].1 == 2)
        #expect(scrolls[0].2 == 3)
        #expect(scrolls[0].3 == 4)
        #expect(windows.count == 1)
        #expect(windows[0].0 == 8)
        #expect(windows[0].1 == 9)
        #expect(tabs.count == 1)
        #expect(tabs[0].0 == 8)
        #expect(tabs[0].1 == 10)
        #expect(tabs[0].2 == 9)
    }

    @Test func multiWindowStateValidatesAndRejectsCrossWindowTabs() throws {
        let build = BrowserProjectionBuildIdentity(version: "0.7.0", commits: 10, sha: "abc1234")
        let tab = BrowserProjectionTab(
            id: 11, windowId: 1, index: 0, active: true, pinned: false,
            title: "Fixture", url: "https://example.com"
        )
        let window = BrowserProjectionWindow(
            id: 1, ordinal: 1, focused: true, activeTabId: 11, tabs: [tab]
        )
        let state = BrowserProjectionState(
            generation: 3, projectedWindowId: 1, focusedWindowId: 1,
            extensionBuild: build, windows: [window]
        )
        try state.validate()

        let invalidTab = BrowserProjectionTab(
            id: 12, windowId: 2, index: 0, active: true, pinned: false,
            title: "Wrong window", url: "https://example.com"
        )
        let invalid = BrowserProjectionState(
            generation: 3, projectedWindowId: 1, focusedWindowId: 1,
            extensionBuild: build,
            windows: [BrowserProjectionWindow(
                id: 1, ordinal: 1, focused: true, activeTabId: 12, tabs: [invalidTab]
            )]
        )
        #expect(throws: BrowserProjectionStateError.crossWindowTab) { try invalid.validate() }
    }

    @Test func stateValidationRejectsMetadataThatCouldEscapeItsWindowContract() throws {
        let build = BrowserProjectionBuildIdentity(version: "0.7.0")
        let invalidFavicon = BrowserProjectionTab(
            id: 11, windowId: 1, index: 0, active: true, pinned: false,
            title: "Fixture", url: "https://example.com",
            favIconDataURL: "data:image/svg+xml;base64,PHN2Zz4="
        )
        let faviconState = BrowserProjectionState(
            generation: 1, projectedWindowId: 1, focusedWindowId: 1,
            extensionBuild: build,
            windows: [BrowserProjectionWindow(
                id: 1, ordinal: 1, focused: true, activeTabId: 11, tabs: [invalidFavicon]
            )]
        )
        #expect(throws: BrowserProjectionStateError.invalidFavicon) { try faviconState.validate() }

        let groupedTab = BrowserProjectionTab(
            id: 12, windowId: 2, index: 0, active: true, pinned: false,
            groupId: 99, title: "Unknown group", url: "https://example.com"
        )
        let groupState = BrowserProjectionState(
            generation: 1, projectedWindowId: 2, focusedWindowId: nil,
            extensionBuild: build,
            windows: [BrowserProjectionWindow(
                id: 2, ordinal: 1, focused: false, activeTabId: 12, tabs: [groupedTab]
            )]
        )
        #expect(throws: BrowserProjectionStateError.unknownTabGroup) { try groupState.validate() }

        let loadingTab = BrowserProjectionTab(
            id: 13, windowId: 3, index: 0, active: true, pinned: false,
            status: "stalled", title: "Bad status", url: "https://example.com"
        )
        let statusState = BrowserProjectionState(
            generation: 1, projectedWindowId: 3, focusedWindowId: 3,
            extensionBuild: build,
            windows: [BrowserProjectionWindow(
                id: 3, ordinal: 1, focused: true, activeTabId: 13, tabs: [loadingTab]
            )]
        )
        #expect(throws: BrowserProjectionStateError.invalidTabStatus) { try statusState.validate() }

        try BrowserProjectionState(
            generation: 2, projectedWindowId: nil, focusedWindowId: nil,
            extensionBuild: build, windows: []
        ).validate()
    }
}
