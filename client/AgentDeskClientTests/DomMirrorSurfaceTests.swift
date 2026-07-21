import Testing
import UIKit

@testable import AgentDeskClient

@MainActor
struct DomMirrorSurfaceTests {
    @Test func hostsSharedBrowserProjectionView() {
        let surface = DomMirrorSurface()
        #expect(surface.projectionViewForTesting.superview === surface)
    }

    @Test func webViewLeavesZoomToTheSharedProjectionRenderer() {
        let surface = DomMirrorSurface()
        let scrollView = surface.projectionViewForTesting.scrollView
        #expect(scrollView.maximumZoomScale == 1)
        #expect(scrollView.minimumZoomScale == 1)
    }

    @Test func sharedRendererScrollIntentIsForwarded() {
        let surface = DomMirrorSurface()
        var forwarded: [(Double, Double, Double, Double)] = []
        surface.onScroll = { x, y, dx, dy in forwarded.append((x, y, dx, dy)) }
        surface.handleScroll(x: 10, y: 20, dx: 0, dy: -100)
        #expect(forwarded.count == 1)
    }

    @Test func forwardsBrowserWindowAndTabSelection() {
        let surface = DomMirrorSurface()
        var windows: [(Int, Int)] = []
        var tabs: [(Int, Int, Int)] = []
        surface.onSelectWindow = { windows.append(($0, $1)) }
        surface.onSelectTab = { tabs.append(($0, $1, $2)) }

        surface.handleSelectWindow(windowId: 8, generation: 9)
        surface.handleSelectTab(windowId: 8, tabId: 10, generation: 9)

        #expect(windows.count == 1)
        #expect(windows[0].0 == 8)
        #expect(windows[0].1 == 9)
        #expect(tabs.count == 1)
        #expect(tabs[0].0 == 8)
        #expect(tabs[0].1 == 10)
        #expect(tabs[0].2 == 9)
    }
}
