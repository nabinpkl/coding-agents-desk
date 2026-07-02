import Testing

// Pure surface -> visibility mapping for the Control | Agent | Browser switcher.
// No view controller required: this is the testable seam that keeps the UIKit
// wiring (applySurface) trivial.
struct ControlSurfaceVisibilityTests {
    @Test func controlShowsChromeHidesOtherSurfaces() {
        let v = visibility(for: .control)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(!v.controlChromeHidden)
        #expect(v.keyboardInteractive)
    }

    @Test func agentShowsWebviewHidesChromeAndBrowser() {
        let v = visibility(for: .agent)
        #expect(!v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func browserShowsMirrorHidesChromeAndAgent() {
        let v = visibility(for: .browser)
        #expect(v.agentHidden)
        #expect(!v.browserHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    // Exactly one full-bleed surface (agent or browser) may be visible at a
    // time; control shows neither. Guards against a future mapping edit that
    // reveals two overlapping surfaces.
    @Test func atMostOneFullBleedSurfaceVisible() {
        for surface in [ControlSurface.control, .agent, .browser] {
            let v = visibility(for: surface)
            let visibleCount = (v.agentHidden ? 0 : 1) + (v.browserHidden ? 0 : 1)
            #expect(visibleCount <= 1)
        }
    }
}
