import AppKit
import Testing
import WebKit

@testable import AgentDeskHost

/// Command+minus / Command+equals zoom for the Agents window.
///
/// The mapping is tested without a window because that is where the decisions are: the host is
/// `LSUIElement`, so there is no menu bar to carry these as menu items and nothing in AppKit matches
/// them for us. The window-level tests below then prove the chord actually reaches the webview,
/// which is the part a pure mapping test cannot say anything about.
@MainActor
@Suite(.serialized)
struct AgentWindowZoomTests {
    private func keyEvent(
        _ characters: String,
        modifiers: NSEvent.ModifierFlags = .command,
        type: NSEvent.EventType = .keyDown
    ) -> NSEvent {
        NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: 0
        )!
    }

    @Test func commandMinusAndEqualsMapToZoomWhateverElseIsHeld() {
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("=")) == .zoomIn)
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("-")) == .zoomOut)
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("0")) == .reset)

        // Shift is not consulted, because the chord people mean by "Command plus" arrives with Shift
        // applied and so reads as "+" rather than "=".
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("+", modifiers: [.command, .shift])) == .zoomIn)
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("_", modifiers: [.command, .shift])) == .zoomOut)

        // Caps lock is noise on the flags, not a different chord.
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("=", modifiers: [.command, .capsLock])) == .zoomIn)
    }

    @Test func chordsThisWindowDoesNotOwnAreLeftAlone() {
        // Without Command these are ordinary typing, and the webview must receive them.
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("=", modifiers: [])) == nil)
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("-", modifiers: [])) == nil)

        // With Option or Control they belong to whatever else claims them; answering here would
        // shadow a binding this window did not define.
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("-", modifiers: [.command, .option])) == nil)
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("=", modifiers: [.command, .control])) == nil)

        #expect(AgentWindowZoomShortcut.command(for: keyEvent("k")) == nil)
        #expect(AgentWindowZoomShortcut.command(for: keyEvent("=", type: .keyUp)) == nil)
    }

    @Test func zoomStepsInTenthsAndStopsAtBothEnds() {
        var zoom = AgentWindowZoom()
        #expect(zoom.scale == 1)

        zoom.apply(.zoomIn)
        #expect(zoom.scale == 1.1)

        // Integer steps, so in-then-out returns to exactly 1.0 rather than near it.
        zoom.apply(.zoomOut)
        #expect(zoom.scale == 1)

        for _ in 0..<40 { zoom.apply(.zoomIn) }
        #expect(zoom.scale == 2)
        for _ in 0..<40 { zoom.apply(.zoomOut) }
        #expect(zoom.scale == 0.6)

        zoom.apply(.reset)
        #expect(zoom.scale == 1)
    }

    @Test func theWindowAnswersTheChordAndScalesTheFeed() async throws {
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            initialFrame: CGRect(x: 80, y: 120, width: 480, height: 720)
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()

        // The key equivalent is owned one level below the window because the window itself is one of
        // two classes depending on `Config.axAutomationEnabled`.
        let contentView = try #require(window.contentView as? AgentWindowContentView)

        #expect(contentView.performKeyEquivalent(with: keyEvent("=")))
        #expect(controller.zoomScaleForTesting == 1.1)
        #expect(contentView.performKeyEquivalent(with: keyEvent("-")))
        #expect(contentView.performKeyEquivalent(with: keyEvent("-")))
        #expect(controller.zoomScaleForTesting == 0.9)
        #expect(contentView.performKeyEquivalent(with: keyEvent("0")))
        #expect(controller.zoomScaleForTesting == 1)

        // A chord this window does not own keeps travelling down to the webview. The return value is
        // deliberately not the assertion: WebKit answers Command+K itself, so `true` here says
        // something about WebKit rather than about this view. What matters is that the zoom did not
        // move.
        _ = contentView.performKeyEquivalent(with: keyEvent("k"))
        #expect(controller.zoomScaleForTesting == 1)

        await controller.beginStop().value
    }

    @Test func theFeedWebviewCarriesTheZoomItWasBuiltAt() async throws {
        let controller = AgentWindowController(
            sidecarClient: FakeSidecarClient(),
            initialFrame: CGRect(x: 80, y: 120, width: 480, height: 720)
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        let contentView = try #require(window.contentView as? AgentWindowContentView)

        // Skipped rather than failed when the bundled panel assets are absent: the window then shows
        // the "unavailable" label and has no webview to scale, which the AX suite tolerates the same
        // way. The mapping and step tests above still hold.
        guard let webView = firstWebView(in: contentView) else {
            await controller.beginStop().value
            return
        }
        #expect(webView.pageZoom == 1)

        _ = contentView.performKeyEquivalent(with: keyEvent("="))
        _ = contentView.performKeyEquivalent(with: keyEvent("="))
        #expect(webView.pageZoom == 1.2)

        _ = contentView.performKeyEquivalent(with: keyEvent("0"))
        #expect(webView.pageZoom == 1)

        await controller.beginStop().value
    }

    private func firstWebView(in view: NSView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for subview in view.subviews {
            if let webView = firstWebView(in: subview) { return webView }
        }
        return nil
    }
}
