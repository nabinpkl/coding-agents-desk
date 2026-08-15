// The z-order bands inside the host content root.
//
// Everything on the session screen used to be a direct child of one container,
// so what covered what was decided by the order things happened to mount in --
// chrome when the session came up, surfaces lazily some time afterwards -- with
// four `bringSubviewToFront` calls patching the places that order came out
// wrong. It worked, and nothing stated it, so the only way to answer "is this
// above that" was to trace the sequence of calls that built the screen.
//
// This is not what produced the strip of frozen video above every surface's top
// bar: the video was already beneath the surfaces, and showed through because
// the surface starts at the safe-area top and does not cover that band. Stopping
// the video from being drawn at all is what fixed that (see `VideoDemand`).
// What the bands remove is the reason nobody could tell those two failures apart
// while reading the code.
//
// Declaration order IS the stacking order, back to front. Mounting into a band
// makes coverage structural: a surface is above the chrome because it is in a
// higher band, not because it was built later.
//
// This file is intentionally dependency-free (no UIKit) so it can be compiled
// into the test target directly -- the repo tests production code via dual
// target membership, not @testable linkage (see ControlSurface.swift).
enum HostContentStage: Int, CaseIterable, Comparable {
    /// What is behind everything, and what fills the screen when no surface is
    /// up: the Mac's pixels and the pointer drawn over them, plus the
    /// pre-session screen (camera preview, pairing status, its buttons). The
    /// two are mutually exclusive in practice and occupy the same real estate,
    /// which is why they share a band rather than each having one.
    case backdrop

    /// The furniture that belongs to the Mac view: trackpad, scroll strip,
    /// button row, display rail, Space and window strips, keyboard helper, and
    /// the media diagnostics readout. It reports on the video, so it is covered
    /// by a surface exactly as the video is.
    case chrome

    /// The full-bleed surfaces that stand in for the Mac view -- agent,
    /// browser, terminal, workspace, IDE -- and the half-height gesture panel.
    case surface

    /// What has to be legible over whatever is beneath it: the host-status
    /// escape hatch, the agent-say banner, the screenshot toast. Membership here
    /// is a claim that a surface must not be able to hide it.
    case overlay

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }

    /// The identifier given to the band's container view, for accessibility
    /// dumps and Maestro hierarchy reads.
    var accessibilityIdentifier: String {
        switch self {
        case .backdrop: return "host-stage-backdrop"
        case .chrome: return "host-stage-chrome"
        case .surface: return "host-stage-surface"
        case .overlay: return "host-stage-overlay"
        }
    }
}
