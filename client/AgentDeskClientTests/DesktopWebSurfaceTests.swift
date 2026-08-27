import AgentDeskWire
import Testing
import UIKit
@testable import AgentDeskClient

@MainActor
struct DesktopWebSurfaceTests {
    @Test func firstNavigationWaitsForVisibleNonzeroViewportAndUsesLatestOrigin() throws {
        let panelView = UIView()
        var loadedOrigins: [URL?] = []
        var viewportAtLoad = CGSize.zero
        let surface = DesktopWebSurface(panelViewForTesting: panelView) { origin in
            loadedOrigins.append(origin)
            viewportAtLoad = panelView.bounds.size
        }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        defer { window.isHidden = true }
        window.addSubview(surface)

        surface.setPresented(true)
        surface.layoutIfNeeded()
        #expect(loadedOrigins.isEmpty)

        let origin = "https://mac.example.ts.net:5173"
        surface.applyPanelOrigin(AgentPanelOriginPush(origin: origin))
        surface.frame = window.bounds
        surface.layoutIfNeeded()

        let expectedOrigin = try #require(URL(string: origin))
        #expect(loadedOrigins.count == 1)
        #expect(loadedOrigins[0] == expectedOrigin)
        #expect(viewportAtLoad == window.bounds.size)

        surface.layoutIfNeeded()
        #expect(loadedOrigins.count == 1)
    }

    @Test func hiddenSurfaceDoesNotNavigateEvenWhenItHasBounds() {
        let panelView = UIView()
        var loadCount = 0
        let surface = DesktopWebSurface(panelViewForTesting: panelView) { _ in loadCount += 1 }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        defer { window.isHidden = true }
        window.addSubview(surface)
        surface.frame = window.bounds

        surface.layoutIfNeeded()

        #expect(loadCount == 0)
        #expect(surface.isHidden)
    }
}
