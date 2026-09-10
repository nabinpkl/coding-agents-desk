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

enum ControlSurface: CaseIterable {
    case control  // trackpad / display rail / keyboard (desktop pixel/video path)
    case agent    // AgentFeedSurface webview
    case browser  // DomMirrorSurface (browser-only DOM path)
    case terminal  // native web terminal PTY client over the dedicated terminal lane
    case workspace // WorkspaceWorkbenchSurface over the dedicated .files lane
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

/// What is on screen, as the ONE surface that owns the content area plus named
/// questions about it. The concrete UIKit wiring (applySurface) just applies the
/// answers.
///
/// It used to be ten independent stored booleans, one per view, filled in by
/// hand in a seven-row switch. Seventy cells, each of which had to be typed
/// correctly and stay correct as surfaces were added -- and the shape could
/// still represent two surfaces visible at once, or none at all. The test that
/// guarded it could only assert "at most one visible", because exactly one was
/// never actually guaranteed. Storing the content surface makes both of those
/// states unrepresentable, so the guarantee comes from the type rather than from
/// the table being right.
struct SurfaceVisibility: Equatable {
    /// The surface that owns the content area. There is always exactly one.
    let content: ControlSurface

    /// Whether this surface's view should be hidden. False for `content` alone.
    /// `.control` has no full-bleed view of its own, so no consumer asks this about it.
    func isHidden(_ surface: ControlSurface) -> Bool { surface != content }

    var agentHidden: Bool { isHidden(.agent) }
    var browserHidden: Bool { isHidden(.browser) }
    var terminalHidden: Bool { isHidden(.terminal) }
    var workspaceHidden: Bool { isHidden(.workspace) }
    var voiceHidden: Bool { isHidden(.voice) }

    /// Voice replaces the host root and the root navigation rail rather than
    /// sitting inside them: it is the one surface mounted on the view controller's
    /// own view instead of on `hostContentView`, so hiding that container is what
    /// clears the screen for it.
    var hostContentHidden: Bool { content == .voice }
    var controlRailHidden: Bool { content == .voice }

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
        case .voice: return "Voice"
        }
    }

    /// Resolves a surface from its switcher accessibility label (the inverse of the property above),
    /// or nil for an unknown label so callers fall back to `.control` safely.
    init?(switcherAccessibilityLabel label: String) {
        guard let match = ControlSurface.allCases
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
    return surfaces
}

/// The named entry point for "what should be on screen for this surface".
/// Kept as a function rather than folded into the memberwise init because it is
/// the vocabulary the UIKit layer and its comments are written in.
func visibility(for surface: ControlSurface) -> SurfaceVisibility {
    SurfaceVisibility(content: surface)
}
