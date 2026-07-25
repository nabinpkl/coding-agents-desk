// The surfaces the control rail can select between. Browser is only
// offered when the session opened a .dom lane.
//
// This file is intentionally dependency-free (no UIKit) so it can be compiled
// into the test target directly — the repo tests production code via dual
// target membership, not @testable linkage (see GestureTranslator.swift).
enum ControlSurface {
    case control  // trackpad / display rail / keyboard (desktop pixel/video path)
    case agent    // AgentFeedSurface webview
    case browser  // DomMirrorSurface (browser-only DOM path)
    case terminal  // native web terminal PTY client over the dedicated terminal lane
    case workspace // WorkspaceWorkbenchSurface over the dedicated .files lane
    case ide // shared responsive Workspace IDE over its own workspace lane
    case voice // VoicePlaygroundSurface: fully on-device, no session lane
}

// Pure surface -> visibility mapping. `controlChromeHidden` covers the
// interactive control surfaces (trackpad, hints, scroll strip, button row,
// display rail); `keyboardInteractive` gates the keyboard helper's
// first-responder handling. The concrete UIKit wiring (applySurface) just
// applies these flags.
struct SurfaceVisibility: Equatable {
    let hostContentHidden: Bool
    let agentHidden: Bool
    let browserHidden: Bool
    let terminalHidden: Bool
    let workspaceHidden: Bool
    let ideHidden: Bool
    let voiceHidden: Bool
    let controlChromeHidden: Bool
    let keyboardInteractive: Bool
}

extension ControlSurface {
    /// SF Symbol name for the control rail. Icons keep the surfaces legible across supported
    /// iPhone heights where text labels would crowd or truncate. Pure (a name string) so it stays in
    /// this UIKit-free, test-compiled file;
    /// the UIKit layer resolves it via `UIImage(systemName:)`.
    var switcherSymbolName: String {
        switch self {
        case .control: return "display"
        case .agent: return "sparkles"
        case .terminal: return "terminal"
        case .browser: return "globe"
        case .workspace: return "rectangle.split.3x1"
        case .ide: return "chevron.left.forwardslash.chevron.right"
        case .voice: return "waveform"
        }
    }

    /// VoiceOver / Maestro accessibility label for the rail button. This is the product-facing surface
    /// name and the stable target used by accessibility-driven flows.
    /// This remains the stable label-to-surface key for accessibility-driven clients.
    var switcherAccessibilityLabel: String {
        switch self {
        case .control: return "Control"
        case .agent: return "Agent"
        case .terminal: return "Terminal"
        case .browser: return "Browser"
        case .workspace: return "Workspace"
        case .ide: return "IDE"
        case .voice: return "Voice"
        }
    }

    /// Resolves a surface from its switcher accessibility label (the inverse of the property above),
    /// or nil for an unknown label so callers fall back to `.control` safely.
    init?(switcherAccessibilityLabel label: String) {
        guard let match = [ControlSurface.control, .agent, .terminal, .browser, .workspace, .ide, .voice]
            .first(where: { $0.switcherAccessibilityLabel == label }) else { return nil }
        self = match
    }
}

/// The ordered host-backed surfaces the session switcher offers. Browser is
/// present only when the session opened a `.dom` lane. Voice deliberately is
/// not in this list: it is a local utility beside Settings and exists before
/// pairing or media initialization.
func availableControlSurfaces(browserAvailable: Bool) -> [ControlSurface] {
    var surfaces: [ControlSurface] = [.control, .agent, .terminal]
    if browserAvailable {
        surfaces.append(.browser)
    }
    surfaces.append(.workspace)
    surfaces.append(.ide)
    return surfaces
}

func visibility(for surface: ControlSurface) -> SurfaceVisibility {
    switch surface {
    case .control:
        return SurfaceVisibility(
            hostContentHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: false, keyboardInteractive: true)
    case .agent:
        return SurfaceVisibility(
            hostContentHidden: false,
            agentHidden: false, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .browser:
        return SurfaceVisibility(
            hostContentHidden: false,
            agentHidden: true, browserHidden: false,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .terminal:
        return SurfaceVisibility(
            hostContentHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: false, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .workspace:
        return SurfaceVisibility(
            hostContentHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: false,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .ide:
        return SurfaceVisibility(
            hostContentHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: false, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .voice:
        return SurfaceVisibility(
            hostContentHidden: true,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: false,
            controlChromeHidden: true, keyboardInteractive: false)
    }
}
