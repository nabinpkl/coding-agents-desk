import Foundation

// Input-declared motion state. The phone causes every scroll, so the host is
// told whether content is at rest or scrolling rather than inferring it from
// pixels. A "flick" is not a separate state: it is scrolling that the link
// cannot keep up with, which the governor handles through the backpressure
// (heldCount) axis below, not through a tuned velocity threshold.
enum MotionState: Equatable, Sendable {
    case rest
    case scrolling
}

// Tuning for MotionGovernor. Top-level to match the project convention and to
// avoid shadowing the global Config its defaults are sourced from.
struct MotionGovernorConfig: Equatable, Sendable {
    let restQuality: Double
    let scrollReadableQuality: Double
    let frameIntervalStepNs: UInt64
    let frameIntervalMaxNs: UInt64
    let busyResolutionScaleFloor: Double

    static let `default` = MotionGovernorConfig(
        restQuality: Config.hybridRestJpegQuality,
        scrollReadableQuality: Config.hybridScrollExposedReadableQuality,
        frameIntervalStepNs: UInt64(max(0, Config.hybridMotionFrameIntervalStepNs)),
        frameIntervalMaxNs: UInt64(max(0, Config.hybridMotionFrameIntervalMaxNs)),
        busyResolutionScaleFloor: Config.hybridBusyResolutionScaleFloor
    )
}

// Maps (motion state, backpressure) to one frame policy. This is the cadence-first
// ladder that replaces the scattered congestion-EWMA + fullframe-quality knobs:
//
//  - Lever 1, cadence: under backpressure (heldCount > 0, the existing unacked-cap
//    signal) the minimum frame interval widens, so frames are rejected/coalesced
//    rather than queued. This is the primary bandwidth release valve.
//  - Lever 2, quality: the lossy-cell / exposed-strip quality is the rest quality
//    at rest and a readable floor while scrolling. It is a function of state only
//    and never drops below the readable floor: cadence and busy-resolution absorb
//    pressure, glyph legibility does not.
//  - Lever 3, resolution: busy (photo) cells may downscale under backpressure;
//    text cells never do (the caller gates this on the busy classification).
//
// Under ADR-0022 every change tiles (no copyRect), so a fast scroll tiles the
// damage at the readable floor and the content cache suppresses re-exposed tiles;
// progressive repaint (later slice) carries the rest back to crisp.
struct MotionGovernor {
    struct Policy: Equatable, Sendable {
        // JPEG quality for lossy cells and the scroll exposed strip.
        let exposedStripQuality: Double
        // Skip producing a frame if the previous produce was more recent than this.
        let minFrameIntervalNs: UInt64
        // Resolution scale the caller applies to BUSY cells only (never text).
        let busyResolutionScale: Double
    }

    private let config: MotionGovernorConfig

    init(config: MotionGovernorConfig = .default) {
        self.config = config
    }

    func policy(state: MotionState, heldCount: Int) -> Policy {
        let held = max(0, heldCount)
        let quality = state == .scrolling ? config.scrollReadableQuality : config.restQuality
        let interval = min(config.frameIntervalMaxNs, UInt64(held) * config.frameIntervalStepNs)
        let busyScale = held > 0 ? config.busyResolutionScaleFloor : 1.0
        return Policy(
            exposedStripQuality: quality,
            minFrameIntervalNs: interval,
            busyResolutionScale: busyScale
        )
    }
}
