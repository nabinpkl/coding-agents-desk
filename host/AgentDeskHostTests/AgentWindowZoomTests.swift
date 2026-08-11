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
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("=")) == .zoomIn)
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("-")) == .zoomOut)
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("0")) == .reset)

        // Shift is not consulted, because the chord people mean by "Command plus" arrives with Shift
        // applied and so reads as "+" rather than "=".
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("+", modifiers: [.command, .shift])) == .zoomIn)
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("_", modifiers: [.command, .shift])) == .zoomOut)

        // Caps lock is noise on the flags, not a different chord.
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("=", modifiers: [.command, .capsLock])) == .zoomIn)
    }

    @Test func chordsThisWindowDoesNotOwnAreLeftAlone() {
        // Without Command these are ordinary typing, and the webview must receive them.
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("=", modifiers: [])) == nil)
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("-", modifiers: [])) == nil)

        // With Option or Control they belong to whatever else claims them; answering here would
        // shadow a binding this window did not define.
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("-", modifiers: [.command, .option])) == nil)
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("=", modifiers: [.command, .control])) == nil)

        #expect(PanelWindowZoomShortcut.command(for: keyEvent("k")) == nil)
        #expect(PanelWindowZoomShortcut.command(for: keyEvent("=", type: .keyUp)) == nil)
    }

    @Test func zoomStepsInTenthsAndStopsAtBothEnds() {
        var zoom = PanelWindowZoom()
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

    @Test func webTitlebarInsetKeepsItsNativePositionAcrossPageZoom() {
        #expect(AgentWindowPanelChrome.cssLeadingInset(points: 117, zoomScale: 1) == 117)
        #expect(AgentWindowPanelChrome.cssLeadingInset(points: 117, zoomScale: 2) == 58.5)
        #expect(AgentWindowPanelChrome.cssLeadingInset(points: 117, zoomScale: 0.6) == 195)

        let initialScript = AgentWindowPanelChrome.leadingInsetUserScript(leadingInset: 117, zoomScale: 2)
        #expect(initialScript.source.contains("window.__agentDeskSetTitlebarLeadingInset = apply;"))
        #expect(initialScript.source.contains("apply(58.5000);"))
        #expect(
            AgentWindowPanelChrome.leadingInsetUpdateScript(leadingInset: 117, zoomScale: 2)
                == "window.__agentDeskSetTitlebarLeadingInset?.(58.5000);"
        )
    }

    @Test func theWebTitleBarReachesTheNativeWindowOverTheChromeChannel() {
        // The entry point is native-installed, which is what keeps the shared bundle free of a
        // Mac-only branch: iOS simply never defines the global the web bundle looks for.
        let source = AgentWindowPanelChrome.windowDragUserScript.source
        #expect(source.contains("window.__agentDeskBeginWindowDrag = () =>"))
        #expect(source.contains("messageHandlers?.\(AgentWindowPanelChrome.messageHandlerName)"))
        #expect(AgentWindowPanelChrome.windowDragUserScript.injectionTime == .atDocumentStart)

        #expect(AgentWindowPanelChrome.command(from: ["t": "drag"]) == .beginWindowDrag)
        #expect(AgentWindowPanelChrome.command(from: ["t": "zoom"]) == nil)
        #expect(AgentWindowPanelChrome.command(from: ["drag": true]) == nil)
        #expect(AgentWindowPanelChrome.command(from: "drag") == nil)
    }

    @Test func theHeldPressSurvivesWhateverTheTrackpadEmitsAfterIt() throws {
        var tracker = AgentWindowPressTracker()
        #expect(tracker.activePress == nil)

        let press = try #require(mouseEvent(.leftMouseDown))
        tracker.record(press)
        #expect(tracker.activePress === press)

        // The regression this exists for. A trackpad press emits `.pressure` events immediately
        // after the mouse-down, so reading `NSApp.currentEvent` once the web round trip answered
        // found one of those and refused to drag. Press-and-hold failed while a quick flick worked,
        // purely because the flick left a `.leftMouseDragged` as the latest event instead.
        //
        // `.pressure` cannot appear below: `NSEvent.mouseEvent` raises on any type outside its mouse
        // mask, and AppKit exposes no other way to build one. These stand in for it as the same
        // thing structurally, an event arriving between the press and its release.
        for interleaved in [NSEvent.EventType.mouseMoved, .leftMouseDragged, .rightMouseDown, .rightMouseUp] {
            tracker.record(try #require(mouseEvent(interleaved)))
            #expect(tracker.activePress === press)
        }

        tracker.record(try #require(mouseEvent(.leftMouseUp)))
        #expect(tracker.activePress == nil)

        // A later press replaces the released one rather than being refused.
        let next = try #require(mouseEvent(.leftMouseDown))
        tracker.record(next)
        #expect(tracker.activePress === next)
    }

    private func mouseEvent(_ type: NSEvent.EventType) -> NSEvent? {
        NSEvent.mouseEvent(
            with: type,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        )
    }

    @Test func theWindowAnswersTheChordAndScalesTheFeed() async throws {
        let controller = AgentWindowController(
            relayClient: InertRelayClient(),
            initialFrame: CGRect(x: 80, y: 120, width: 480, height: 720)
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()

        // The key equivalent is owned one level below the window because the window itself is one of
        // two classes depending on `Config.axAutomationEnabled`.
        let contentView = try #require(window.contentView as? PanelWindowContentView)
        contentView.layoutSubtreeIfNeeded()

        #expect(contentView.performKeyEquivalent(with: keyEvent("=")))
        contentView.layoutSubtreeIfNeeded()
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
            relayClient: InertRelayClient(),
            initialFrame: CGRect(x: 80, y: 120, width: 480, height: 720)
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        let contentView = try #require(window.contentView as? PanelWindowContentView)

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

    @Test func bothHalvesOfTheWindowMoveTogether() async throws {
        let terminal = FakeAgentWindowTerminalController()
        let controller = AgentWindowController(
            relayClient: InertRelayClient(),
            terminalControllerForTesting: terminal,
            initialFrame: CGRect(x: 80, y: 120, width: 480, height: 720)
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        let contentView = try #require(window.contentView as? PanelWindowContentView)

        _ = contentView.performKeyEquivalent(with: keyEvent("="))
        _ = contentView.performKeyEquivalent(with: keyEvent("="))
        _ = contentView.performKeyEquivalent(with: keyEvent("-"))

        // The terminal gets the same level, which it turns into a font size rather than a page
        // scale. Zooming half a window is worse than not zooming it.
        #expect(terminal.zoomScales == [1.1, 1.2, 1.1])

        await controller.beginStop().value
    }

    @Test func aRestoredWindowOpensAtItsRememberedLevelAndReportsEveryChange() async throws {
        let terminal = FakeAgentWindowTerminalController()
        var reported: [Int] = []
        let controller = AgentWindowController(
            relayClient: InertRelayClient(),
            terminalControllerForTesting: terminal,
            initialFrame: CGRect(x: 80, y: 120, width: 480, height: 720),
            initialZoomStep: 4
        )
        controller.observePresentation(
            placementChanged: { _ in },
            terminalChanged: { _ in },
            zoomChanged: { reported.append($0) }
        )
        controller.show()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        let contentView = try #require(window.contentView as? PanelWindowContentView)

        #expect(controller.zoomScaleForTesting == 1.4)
        if let webView = firstWebView(in: contentView) {
            // Built at the restored level, not zoomed up to it afterwards.
            #expect(webView.pageZoom == 1.4)
        }
        // The terminal is NOT told here, and should not be: its pane has not opened. The real
        // controller sends the level from its `setTerminalOpen` hook, which is the only moment a
        // restored pane has a renderer to receive it. The injected fake bypasses that hook.
        #expect(terminal.zoomScales.isEmpty)

        _ = contentView.performKeyEquivalent(with: keyEvent("-"))
        _ = contentView.performKeyEquivalent(with: keyEvent("0"))
        // Only changes are reported: the registry writes on each one, and a step that clamped to
        // where it already was is not a change.
        #expect(reported == [3, 0])

        await controller.beginStop().value
    }

    @Test func aStepFromOutsideTheSupportedRangeIsClampedOnTheWayIn() {
        // The store is the untrusted input here: a build with a wider range, or a hand-edited file,
        // must not land a window at a size its own keys cannot walk back from.
        #expect(PanelWindowZoom(step: 99).scale == 2)
        #expect(PanelWindowZoom(step: -99).scale == 0.6)
        #expect(PanelWindowZoom(step: 3).scale == 1.3)
    }

    private func firstWebView(in view: NSView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for subview in view.subviews {
            if let webView = firstWebView(in: subview) { return webView }
        }
        return nil
    }
}
