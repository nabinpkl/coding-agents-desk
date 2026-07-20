import Foundation
import Testing
import WebKit
@testable import BrowserProjection

@MainActor
struct BrowserProjectionControllerTests {
    @Test func bundledReplayRuntimeHasOneDeliverEntrypoint() throws {
        let indexURL = try #require(BrowserProjectionResources.indexURL)
        let html = try String(contentsOf: indexURL, encoding: .utf8)

        #expect(html.contains("window.__domMirrorDeliver"))
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
        #expect(scripts.allSatisfy { $0.hasPrefix("window.__domMirrorDeliver(") })
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
        controller.onTap = { taps.append(($0, $1)) }
        controller.onScroll = { scrolls.append(($0, $1, $2, $3)) }

        controller.handleScriptMessage(["kind": "tap", "x": 12, "y": 34])
        controller.handleScriptMessage(["kind": "scroll", "x": 1, "y": 2, "dx": 3, "dy": 4])

        #expect(taps.count == 1)
        #expect(taps[0].0 == 12)
        #expect(taps[0].1 == 34)
        #expect(scrolls.count == 1)
        #expect(scrolls[0].0 == 1)
        #expect(scrolls[0].1 == 2)
        #expect(scrolls[0].2 == 3)
        #expect(scrolls[0].3 == 4)
    }
}
