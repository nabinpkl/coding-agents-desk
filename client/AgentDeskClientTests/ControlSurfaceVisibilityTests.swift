import Testing
import UIKit

// Pure surface -> visibility mapping for the shared surface control rail.
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

    @Test func workspaceShowsWorkspaceHidesChromeAndOtherSurfaces() {
        let v = visibility(for: .workspace)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(!v.workspaceHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func ideShowsIDEAndHidesEveryOtherSurface() {
        let v = visibility(for: .ide)
        #expect(!v.ideHidden)
        #expect(v.workspaceHidden)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
    }

    // Exactly one full-bleed surface (agent, browser, terminal, or files) may be visible at a
    // time; control shows neither. Guards against a future mapping edit that
    // reveals two overlapping surfaces.
    @Test func atMostOneFullBleedSurfaceVisible() {
        for surface in [ControlSurface.control, .agent, .browser, .terminal, .workspace, .ide, .voice] {
            let v = visibility(for: surface)
            let visibleCount = (v.agentHidden ? 0 : 1)
                + (v.browserHidden ? 0 : 1)
                + (v.terminalHidden ? 0 : 1)
                + (v.workspaceHidden ? 0 : 1)
                + (v.ideHidden ? 0 : 1)
                + (v.voiceHidden ? 0 : 1)
            #expect(visibleCount <= 1)
        }
    }

    @Test func voiceShowsProbeAndHidesEveryOtherSurface() {
        let v = visibility(for: .voice)
        #expect(!v.voiceHidden)
        #expect(v.ideHidden)
        #expect(v.workspaceHidden)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
        // The probe's own text field is a local first responder; the host
        // keyboard helper must stay disabled so keys are not forwarded to the Mac.
        #expect(!v.keyboardInteractive)
    }
}

// R30: the rail offers icon buttons for every surface, fitting narrow iPhone widths where text
// labels crowd. These pin the pure ordering/availability and per-surface metadata the UIKit
// switcher builds from (and that a11y-driven flows target by label).
struct SurfaceSwitcherTests {
    @Test func withoutBrowserOffersFiveSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: false) == [.control, .agent, .terminal, .workspace, .ide, .voice])
    }

    @Test func withBrowserOffersSixSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: true) == [.control, .agent, .terminal, .browser, .workspace, .ide, .voice])
    }

    @Test func everySurfaceHasADistinctSymbolAndStableAccessibilityLabel() {
        let all: [ControlSurface] = [.control, .agent, .terminal, .browser, .workspace, .ide, .voice]
        // Distinct SF Symbols so all segments are visually distinguishable.
        let symbols = all.map(\.switcherSymbolName)
        #expect(Set(symbols).count == all.count)
        symbols.forEach { #expect(!$0.isEmpty) }
        // Labels are the product-facing words the a11y-driven Maestro flows tap.
        #expect(ControlSurface.control.switcherAccessibilityLabel == "Control")
        #expect(ControlSurface.agent.switcherAccessibilityLabel == "Agent")
        #expect(ControlSurface.terminal.switcherAccessibilityLabel == "Terminal")
        #expect(ControlSurface.browser.switcherAccessibilityLabel == "Browser")
        #expect(ControlSurface.workspace.switcherSymbolName == "rectangle.split.3x1")
        #expect(UIImage(systemName: ControlSurface.workspace.switcherSymbolName) != nil)
        #expect(ControlSurface.workspace.switcherAccessibilityLabel == "Workspace")
        #expect(ControlSurface.ide.switcherAccessibilityLabel == "IDE")
        #expect(ControlSurface.voice.switcherAccessibilityLabel == "Voice")
        #expect(UIImage(systemName: ControlSurface.voice.switcherSymbolName) != nil)
    }

    // The switcher resolves a tapped segment back to its surface via the label round-trip, so this
    // inverse must hold for every surface and reject unknown labels (-> safe .control fallback).
    @Test func accessibilityLabelRoundTripsToSurface() {
        for surface in [ControlSurface.control, .agent, .terminal, .browser, .workspace, .ide, .voice] {
            #expect(ControlSurface(switcherAccessibilityLabel: surface.switcherAccessibilityLabel) == surface)
        }
        #expect(ControlSurface(switcherAccessibilityLabel: "Nonexistent") == nil)
    }
}
