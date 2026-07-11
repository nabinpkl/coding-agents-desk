import Testing

// Pure surface -> visibility mapping for the Control | Agent | Browser switcher.
// No view controller required: this is the testable seam that keeps the UIKit
// wiring (applySurface) trivial.
struct ControlSurfaceVisibilityTests {
    @Test func controlShowsChromeHidesOtherSurfaces() {
        let v = visibility(for: .control)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(!v.controlChromeHidden)
        #expect(v.keyboardInteractive)
    }

    @Test func agentShowsWebviewHidesChromeAndBrowser() {
        let v = visibility(for: .agent)
        #expect(!v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func browserShowsMirrorHidesChromeAndAgent() {
        let v = visibility(for: .browser)
        #expect(v.agentHidden)
        #expect(!v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func terminalShowsTerminalHidesChromeAndOtherSurfaces() {
        let v = visibility(for: .terminal)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(!v.terminalHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func filesShowsFilesHidesChromeAndOtherSurfaces() {
        let v = visibility(for: .files)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(!v.filesHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    // Exactly one full-bleed surface (agent, browser, terminal, or files) may be visible at a
    // time; control shows neither. Guards against a future mapping edit that
    // reveals two overlapping surfaces.
    @Test func atMostOneFullBleedSurfaceVisible() {
        for surface in [ControlSurface.control, .agent, .browser, .terminal, .files] {
            let v = visibility(for: surface)
            let visibleCount = (v.agentHidden ? 0 : 1)
                + (v.browserHidden ? 0 : 1)
                + (v.terminalHidden ? 0 : 1)
                + (v.filesHidden ? 0 : 1)
            #expect(visibleCount <= 1)
        }
    }
}

// R30: the switcher offers icon segments for every surface, fitting narrow iPhone widths where five
// text labels crowd. These pin the pure ordering/availability and per-surface metadata the UIKit
// switcher builds from (and that a11y-driven flows target by label).
struct SurfaceSwitcherTests {
    @Test func withoutBrowserOffersFourSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: false) == [.control, .agent, .terminal, .files])
    }

    @Test func withBrowserOffersFiveSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: true) == [.control, .agent, .terminal, .browser, .files])
    }

    @Test func everySurfaceHasADistinctSymbolAndStableAccessibilityLabel() {
        let all: [ControlSurface] = [.control, .agent, .terminal, .browser, .files]
        // Distinct SF Symbols so the five segments are visually distinguishable.
        let symbols = all.map(\.switcherSymbolName)
        #expect(Set(symbols).count == all.count)
        symbols.forEach { #expect(!$0.isEmpty) }
        // Labels are the historical words the a11y-driven Maestro flows tap.
        #expect(ControlSurface.control.switcherAccessibilityLabel == "Control")
        #expect(ControlSurface.agent.switcherAccessibilityLabel == "Agent")
        #expect(ControlSurface.terminal.switcherAccessibilityLabel == "Terminal")
        #expect(ControlSurface.browser.switcherAccessibilityLabel == "Browser")
        #expect(ControlSurface.files.switcherAccessibilityLabel == "Files")
    }

    // The switcher resolves a tapped segment back to its surface via the label round-trip, so this
    // inverse must hold for every surface and reject unknown labels (-> safe .control fallback).
    @Test func accessibilityLabelRoundTripsToSurface() {
        for surface in [ControlSurface.control, .agent, .terminal, .browser, .files] {
            #expect(ControlSurface(switcherAccessibilityLabel: surface.switcherAccessibilityLabel) == surface)
        }
        #expect(ControlSurface(switcherAccessibilityLabel: "Nonexistent") == nil)
    }
}
