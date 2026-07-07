// The surfaces the top switcher can select between. Browser is only
// offered as a segment when the session opened a .dom lane.
//
// This file is intentionally dependency-free (no UIKit) so it can be compiled
// into the test target directly — the repo tests production code via dual
// target membership, not @testable linkage (see GestureTranslator.swift).
enum ControlSurface {
    case control  // trackpad / display rail / keyboard (desktop pixel/video path)
    case agent    // AgentFeedSurface webview
    case browser  // DomMirrorSurface (browser-only DOM path)
    case terminal // SwiftTerm PTY client over the dedicated terminal lane
}

// Pure surface -> visibility mapping. `controlChromeHidden` covers the
// interactive control surfaces (trackpad, hints, scroll strip, button row,
// display rail); `keyboardInteractive` gates the keyboard helper's
// first-responder handling. The concrete UIKit wiring (applySurface) just
// applies these flags.
struct SurfaceVisibility: Equatable {
    let agentHidden: Bool
    let browserHidden: Bool
    let terminalHidden: Bool
    let controlChromeHidden: Bool
    let keyboardInteractive: Bool
}

func visibility(for surface: ControlSurface) -> SurfaceVisibility {
    switch surface {
    case .control:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: true,
            terminalHidden: true,
            controlChromeHidden: false, keyboardInteractive: true)
    case .agent:
        return SurfaceVisibility(
            agentHidden: false, browserHidden: true,
            terminalHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .browser:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: false,
            terminalHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .terminal:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: true,
            terminalHidden: false,
            controlChromeHidden: true, keyboardInteractive: false)
    }
}
