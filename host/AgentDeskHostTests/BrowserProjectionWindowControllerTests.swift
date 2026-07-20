import AppKit
import BrowserProjection
import Testing

@testable import AgentDeskHost

@MainActor
struct BrowserProjectionWindowControllerTests {
    @Test func windowHostsTheSharedProjectionWebView() {
        let controller = BrowserProjectionWindowController()

        #expect(controller.window?.title == "Browser Projection")
        #expect(controller.window?.contentView === controller.projectionViewForTesting)
        #expect(controller.window?.styleMask.contains(.resizable) == true)
        #expect(controller.window?.isReleasedWhenClosed == false)

        controller.stop()
    }

    @Test func localLaneDeliversBatchesInSendOrder() async {
        let controller = BrowserProjectionWindowController()
        let lane = BrowserProjectionLocalLane(controller: controller)
        let checkout = Data(#"{"t":"dom-batch","tb":7,"co":true,"ev":[]}"#.utf8)
        let incremental = Data(#"{"t":"dom-batch","tb":7,"co":false,"ev":[]}"#.utf8)
        var received: [Data] = []

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            controller.onBatchForTesting = { payload in
                received.append(payload)
                if received.count == 2 { continuation.resume() }
            }
            lane.send(checkout)
            lane.send(incremental)
        }

        #expect(received == [checkout, incremental])
        lane.close()
        controller.stop()
    }
}
