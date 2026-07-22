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
    case terminal  // native web terminal PTY client over the dedicated terminal lane
    case workspace // WorkspaceWorkbenchSurface over the dedicated .files lane
    case ide // shared responsive Workspace IDE over its own workspace lane
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
    let workspaceHidden: Bool
    let ideHidden: Bool
    let controlChromeHidden: Bool
    let keyboardInteractive: Bool
}

extension ControlSurface {
    /// SF Symbol name for the switcher segment. Icons keep all six segments legible across supported
    /// iPhone widths where text labels would crowd or truncate. Pure (a name string) so it stays in
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
        }
    }

    /// VoiceOver / Maestro accessibility label for the segment. This is the product-facing surface
    /// name and the stable target used by accessibility-driven flows.
    /// This label is also the switcher's read-back key: the UIKit layer resolves a tapped segment
    /// back to its surface via `ControlSurface(switcherAccessibilityLabel:)` on the segment's own
    /// image label, so the mapping reads what was actually built rather than re-deriving availability.
    var switcherAccessibilityLabel: String {
        switch self {
        case .control: return "Control"
        case .agent: return "Agent"
        case .terminal: return "Terminal"
        case .browser: return "Browser"
        case .workspace: return "Workspace"
        case .ide: return "IDE"
        }
    }

    /// Resolves a surface from its switcher accessibility label (the inverse of the property above),
    /// or nil for an unknown label so callers fall back to `.control` safely.
    init?(switcherAccessibilityLabel label: String) {
        guard let match = [ControlSurface.control, .agent, .terminal, .browser, .workspace, .ide]
            .first(where: { $0.switcherAccessibilityLabel == label }) else { return nil }
        self = match
    }
}

/// The ordered surfaces the switcher offers. Browser is present only when the session opened a `.dom`
/// lane; the rest are always available. Pure so the ordering + availability is unit-tested without
/// UIKit, and so selection can map by index into this list rather than by matching segment titles.
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
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true,
            controlChromeHidden: false, keyboardInteractive: true)
    case .agent:
        return SurfaceVisibility(
            agentHidden: false, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .browser:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: false,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .terminal:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: true,
            terminalHidden: false, workspaceHidden: true,
            ideHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .workspace:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: false,
            ideHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .ide:
        return SurfaceVisibility(
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: false,
            controlChromeHidden: true, keyboardInteractive: false)
    }
}
