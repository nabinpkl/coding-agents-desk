import AppKit
import AgentDeskWire
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
        #expect(controller.window?.accessibilityIdentifier() == "browser-projection-window")

        controller.stop()
    }

    @Test func localLaneFiltersStaleBatchesAndPreservesDeliveryOrder() async throws {
        let controller = BrowserProjectionWindowController()
        let session = BrowserProjectionSession(hostSHA: "host123") { _ in true }
        let lane = BrowserProjectionLocalLane(session: session)
        let state = fixtureState(generation: 4)
        let statePayload = try JSONEncoder().encode(state)
        let staleStatePayload = try JSONEncoder().encode(fixtureState(generation: 3))
        let sameGenerationRetargetPayload = try JSONEncoder().encode(fixtureState(
            generation: 4,
            projectedWindowId: 2
        ))
        let stale = Data(#"{"t":"dom-batch","tb":11,"g":3,"co":true,"ev":[]}"#.utf8)
        let checkout = Data(#"{"t":"dom-batch","tb":11,"g":4,"co":true,"ev":[]}"#.utf8)
        var received: [Data] = []

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            controller.onPayloadForTesting = { payload in
                received.append(payload)
                if received.count == 3 { continuation.resume() }
            }
            session.attach(controller)
            lane.send(.browserState(statePayload, state))
            lane.send(.browserState(
                sameGenerationRetargetPayload,
                fixtureState(generation: 4, projectedWindowId: 2)
            ))
            lane.send(.browserState(staleStatePayload, fixtureState(generation: 3)))
            lane.send(.batch(stale))
            lane.send(.batch(checkout))
        }

        #expect(received[1] == statePayload)
        #expect(received[2] == checkout)
        #expect(!received.contains(sameGenerationRetargetPayload))
        #expect(!received.contains(staleStatePayload))
        #expect(!received.contains(stale))
        lane.close()
        controller.stop()
    }

    @Test func sessionRoutesOnlyValidatedWindowTabAndPageCommands() throws {
        var sent: [Data] = []
        let session = BrowserProjectionSession(hostSHA: "host123") { payload in
            sent.append(payload)
            return true
        }
        let state = fixtureState(generation: 6)
        session.receiveBrowserState(try JSONEncoder().encode(state), state: state)

        session.selectWindow(2, generation: 6)
        session.selectTab(1, tabId: 12, generation: 6)
        session.tap(x: 10, y: 20)
        session.scroll(x: 1, y: 2, dx: 3, dy: 4)
        session.selectWindow(2, generation: 5)

        let types = try sent.map { payload -> String in
            let object = try #require(JSONSerialization.jsonObject(with: payload) as? [String: Any])
            return try #require(object["t"] as? String)
        }
        #expect(types == ["browser-select-window", "browser-select-tab", "dom-input", "dom-scroll"])

        var loadingCommands: [Data] = []
        let loadingSession = BrowserProjectionSession(hostSHA: "host123") { payload in
            loadingCommands.append(payload)
            return true
        }
        let loadingState = fixtureState(generation: 7, tabStatus: "loading")
        loadingSession.receiveBrowserState(
            try JSONEncoder().encode(loadingState),
            state: loadingState
        )
        loadingSession.tap(x: 10, y: 20)
        loadingSession.scroll(x: 1, y: 2, dx: 3, dy: 4)
        #expect(loadingCommands.isEmpty)
    }

    private func fixtureState(
        generation: Int,
        tabStatus: String = "complete",
        projectedWindowId: Int = 1
    ) -> BrowserProjectionState {
        let firstTabs = [
            BrowserProjectionTab(
                id: 11, windowId: 1, index: 0, active: true, pinned: false,
                status: tabStatus, title: "One", url: "https://one.test"
            ),
            BrowserProjectionTab(
                id: 12, windowId: 1, index: 1, active: false, pinned: false,
                title: "Other", url: "https://one.test/other"
            ),
        ]
        return BrowserProjectionState(
            generation: generation,
            projectedWindowId: projectedWindowId,
            focusedWindowId: 2,
            extensionBuild: BrowserProjectionBuildIdentity(version: "0.7.0", sha: "ext123"),
            windows: [
                BrowserProjectionWindow(
                    id: 1, ordinal: 1, focused: false, activeTabId: 11, tabs: firstTabs
                ),
                BrowserProjectionWindow(
                    id: 2,
                    ordinal: 2,
                    focused: true,
                    activeTabId: 21,
                    tabs: [BrowserProjectionTab(
                        id: 21, windowId: 2, index: 0, active: true, pinned: false,
                        title: "Two", url: "https://two.test"
                    )]
                ),
            ]
        )
    }
}
