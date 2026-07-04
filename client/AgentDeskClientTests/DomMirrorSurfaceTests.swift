import Foundation
import Testing
import UIKit

@testable import AgentDeskClient

@MainActor
struct DomMirrorSurfaceTests {
    @Test func deliverInvokesReplayerBridgeWithBatch() {
        let surface = DomMirrorSurface()
        var captured: [String] = []
        surface.evaluateScript = { captured.append($0) }
        surface.markLoaded()
        surface.deliver(rawJSON: #"{"t":"dom-batch","tb":1,"co":true,"ev":[]}"#)

        #expect(captured.count == 1)
        #expect(captured[0].contains("window.__domMirrorDeliver("))
        #expect(captured[0].contains("dom-batch"))
    }

    @Test func deliverQueuesUntilLoadedThenFlushes() {
        let surface = DomMirrorSurface()
        var captured: [String] = []
        surface.evaluateScript = { captured.append($0) }

        surface.deliver(rawJSON: #"{"t":"dom-batch"}"#) // before load -> queued
        #expect(captured.isEmpty)

        surface.markLoaded()
        #expect(captured.count == 1)
        #expect(captured[0].contains("__domMirrorDeliver"))
    }

    @Test func teardownStopsFurtherDelivery() {
        let surface = DomMirrorSurface()
        var captured: [String] = []
        surface.evaluateScript = { captured.append($0) }
        surface.markLoaded()
        surface.teardown()
        surface.deliver(rawJSON: #"{"t":"dom-batch"}"#)
        #expect(captured.isEmpty)
    }
}
