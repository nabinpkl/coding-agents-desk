import Foundation
import Testing
import UIKit
import WebKit

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

    // ADR-0047 Phase 2: the mirror's WKWebView is configured for pinch-zoom (readability magnify), so
    // the scrollView admits a zoom range above 1x. Regression guard that construction sets it; the
    // mapping-under-zoom correctness is covered by the E2E/gesture gates, not here.
    @Test func webViewEnablesPinchZoom() {
        let surface = DomMirrorSurface()
        let scrollView = surface.subviews.compactMap { $0 as? WKWebView }.first?.scrollView
        #expect(scrollView?.maximumZoomScale ?? 0 > 1)
        #expect(scrollView?.minimumZoomScale == 1)
    }

    // ADR-0047 Phase 2: a scroll drag drives the host ONLY at 1x. Once pinch-zoomed (zoomScale > 1) the
    // single-finger drag pans the magnified view locally, so handleScroll must NOT forward to the host
    // (the two-input collision otherwise both pans locally and scrolls the real tab).
    @Test func scrollDriveIsSuppressedWhilePinchZoomed() {
        let surface = DomMirrorSurface()
        var forwarded: [(Double, Double, Double, Double)] = []
        surface.onScroll = { x, y, dx, dy in forwarded.append((x, y, dx, dy)) }
        let scrollView = surface.subviews.compactMap { $0 as? WKWebView }.first?.scrollView

        // At 1x, the drag drives the host.
        scrollView?.zoomScale = 1
        surface.handleScroll(x: 10, y: 20, dx: 0, dy: -100)
        #expect(forwarded.count == 1)

        // Zoomed in, the same drag is a local pan; nothing reaches the host.
        scrollView?.zoomScale = 2
        surface.handleScroll(x: 10, y: 20, dx: 0, dy: -100)
        #expect(forwarded.count == 1) // unchanged
    }
}
