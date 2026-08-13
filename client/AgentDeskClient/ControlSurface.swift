// The surfaces the control rail can select between. Browser is only
// offered when the session opened a .dom lane.
//
// This file is intentionally dependency-free (no UIKit) so it can be compiled
// into the test target directly — the repo tests production code via dual
// target membership, not @testable linkage (see GestureTranslator.swift).
/// Whether the Mac's pixels are wanted, as one value with two obligations.
///
/// `.none` means BOTH "tell the host to stop encoding" and "stop painting". A
/// consumer that honours one and not the other is the bug this type exists to
/// prevent, so neither case is named for a single consumer.
enum VideoDemand: Equatable {
    /// Frames are wanted, and painted as they arrive.
    case live
    /// No frames. The host stops producing them and the stage stops showing the
    /// last one it received.
    case none
}

enum ControlSurface {
    case control  // trackpad / display rail / keyboard (desktop pixel/video path)
    case agent    // AgentFeedSurface webview
    case browser  // DomMirrorSurface (browser-only DOM path)
    case terminal  // native web terminal PTY client over the dedicated terminal lane
    case workspace // WorkspaceWorkbenchSurface over the dedicated .files lane
    case ide // shared responsive Workspace IDE over its own workspace lane
    case voice // VoicePlaygroundSurface: fully on-device, no session lane
}

/// Decides when the session's orientation-variant constraints must be rebuilt or dropped.
///
/// Those constraints position two pieces against each other -- the control shell (trackpad,
/// strip, button row, rails) and the video sink's scroll view -- so the set is only meaningful
/// while the composition it was derived from still holds. Either piece can mount and unmount
/// on its own schedule, so this tracks the composition the installed set came from and reports
/// what the difference requires.
///
/// It replaced a one-shot "install once when both are mounted" gate, which was correct for the
/// first connect and wrong for every reconnect that kept the video. The surface-preserving
/// teardown drops the shell and clears the constraints while deliberately holding on to the
/// sink; the sink was mounted exactly once per sink, so after that its half of the set had no
/// producer left. The video view then laid out at zero height with a fully healthy decoder
/// still drawing into it -- a black screen that survived every reconnect and cleared only on
/// relaunch (R230). Deriving the whole set from the current composition, every time the
/// composition changes, is what removes that class of bug rather than this one instance of it.
struct SessionLayoutConstraints {
    /// Which arrangement the mounted pieces can express.
    enum Layout: Equatable {
        /// Shell and sink together: video, trackpad, strip, rails, button row.
        case session
        /// The sink alone, while the shell is torn down across a reconnect. The video keeps
        /// its position and extent so the frame preserved for the outage stays on screen and
        /// in place; without this the scroll view has no constraints at all for the length of
        /// the outage and collapses, which the user sees as black (R230).
        case videoOnly
    }

    enum Reconciliation: Equatable {
        /// The installed set already matches what is mounted.
        case upToDate
        /// Discard the installed set and derive the named arrangement from what is mounted.
        case rebuild(Layout)
        /// Nothing left to lay out; drop the set without replacing it.
        case clear
    }

    private struct Composition: Equatable {
        let shellMounted: Bool
        let sinkMounted: Bool

        /// Nil when nothing is layoutable. A sink with no shell still is: it is the reconnect
        /// state, and it is the one this used to get wrong by treating it as nothing.
        var layout: Layout? {
            guard sinkMounted else { return nil }
            return shellMounted ? .session : .videoOnly
        }
    }

    /// The composition the installed constraints were derived from, or nil when none are
    /// installed. Never holds a composition that is missing a piece: an incomplete
    /// composition cannot produce constraints, so there is nothing to remember.
    private var derivedFrom: Composition?

    var hasInstalledConstraints: Bool { derivedFrom != nil }

    mutating func reconcile(shellMounted: Bool, sinkMounted: Bool) -> Reconciliation {
        let current = Composition(shellMounted: shellMounted, sinkMounted: sinkMounted)
        guard let layout = current.layout else {
            guard derivedFrom != nil else { return .upToDate }
            derivedFrom = nil
            return .clear
        }
        guard derivedFrom != current else { return .upToDate }
        derivedFrom = current
        return .rebuild(layout)
    }
}

// Pure surface -> visibility mapping. `controlRailHidden` controls the
// root navigation rail, while `controlChromeHidden` covers the
// interactive control surfaces (trackpad, hints, scroll strip, button row,
// display rail); `keyboardInteractive` gates the keyboard helper's
// first-responder handling. The concrete UIKit wiring (applySurface) just
// applies these flags.
struct SurfaceVisibility: Equatable {
    let hostContentHidden: Bool
    let controlRailHidden: Bool
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

    /// Whether this surface needs the Mac's pixels.
    ///
    /// The one home for that question, because it has two consumers that must
    /// agree: the WIRE (the host stops encoding for this client when nothing
    /// wants frames, so they cost no downlink and no Mac encode) and the SCREEN
    /// (a stage with no frames arriving must not keep painting the last one).
    ///
    /// They used to be two facts. The wire read `watchesHostVideo`; the screen
    /// read nothing at all, because the video's visibility was left to whatever
    /// happened to cover it, on the theory that every non-Control surface is
    /// full-bleed. That theory was false in exactly one of three layout modes --
    /// split portrait pins the video to the raw view top while a surface pins to
    /// the safe-area top -- so the host stopped encoding while the last decoded
    /// frame sat frozen in the uncovered strip above every surface. Deriving both
    /// consumers from one value is what makes that state unrepresentable rather
    /// than fixed.
    var videoDemand: VideoDemand { self == .control ? .live : .none }

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
            controlRailHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: false, keyboardInteractive: true)
    case .agent:
        return SurfaceVisibility(
            hostContentHidden: false,
            controlRailHidden: false,
            agentHidden: false, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .browser:
        return SurfaceVisibility(
            hostContentHidden: false,
            controlRailHidden: false,
            agentHidden: true, browserHidden: false,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .terminal:
        return SurfaceVisibility(
            hostContentHidden: false,
            controlRailHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: false, workspaceHidden: true,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .workspace:
        return SurfaceVisibility(
            hostContentHidden: false,
            controlRailHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: false,
            ideHidden: true, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .ide:
        return SurfaceVisibility(
            hostContentHidden: false,
            controlRailHidden: false,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: false, voiceHidden: true,
            controlChromeHidden: true, keyboardInteractive: false)
    case .voice:
        return SurfaceVisibility(
            hostContentHidden: true,
            controlRailHidden: true,
            agentHidden: true, browserHidden: true,
            terminalHidden: true, workspaceHidden: true,
            ideHidden: true, voiceHidden: false,
            controlChromeHidden: true, keyboardInteractive: false)
    }
}
