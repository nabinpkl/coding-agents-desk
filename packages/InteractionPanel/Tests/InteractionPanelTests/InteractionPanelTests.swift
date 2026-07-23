import Foundation
import Testing
import WebPanelKit
@testable import InteractionPanel

struct InteractionPanelTests {
    @Test func decodesSpaceStepDeltas() {
        #expect(
            InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": 1])
                == .spaceStep(delta: 1)
        )
        #expect(
            InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": -1])
                == .spaceStep(delta: -1)
        )
    }

    @Test func rejectsOutOfRangeOrMalformedSpaceStep() {
        #expect(InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": 2]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": 0]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "spaceStep", body: [:]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "unknown", body: ["delta": 1]) == nil)
    }

    @Test func interactionContractIsDistinctFromAgentFeed() {
        #expect(WebPanelContract.interaction.scheme == "interactionfeed")
        #expect(WebPanelContract.interaction.messageHandlerName == "interaction")
        #expect(
            WebPanelContract.interaction.indexRequestURL?.absoluteString
                == "interactionfeed://app/index.html"
        )
    }

    @Test func fixtureResolvesForCleanBuilds() throws {
        let locator = WebPanelResourceLocator(
            bundle: .module,
            webviewDirectoryName: InteractionPanelResources.webviewDirectoryName,
            fixtureDirectoryName: InteractionPanelResources.fixtureDirectoryName
        )
        let root = try #require(locator.rootDirectory())
        let index = try #require(locator.indexURL())

        #expect(root.lastPathComponent == "InteractionPanelFixture")
        #expect(
            String(decoding: try Data(contentsOf: index), as: UTF8.self)
                .contains("InteractionPanel fixture")
        )
    }
}
