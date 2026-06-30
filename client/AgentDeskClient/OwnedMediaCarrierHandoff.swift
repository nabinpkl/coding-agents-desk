import Foundation

// DEAD as of ADR-0034 crisp-repair (R7): the video/tiles whole-surface swap is retired;
// the video floor and crisp overlay now composite together (see OwnedMediaVideoSink). This
// type has no production caller; only its own tests reference it. Slated for removal in the
// post-R9 dead-code sweep alongside the dormant host tile machinery, kept until then so the
// retirement lands as one reviewed batch once crisp-repair is device-proven.
//
// Phase 4 of the mixed-mode renderer (ADR-0025): the swap between the video layer
// (scrolling motion) and the retained tile surface (rest). The host declares the
// motion state; the phone causes every scroll, so this is a truth, not a guess.
//
// The one coherence-sensitive seam is scroll -> rest. The video's last frame and
// the first crisp tile must show the same pixels, so the swap is a quality sharpen
// rather than a content jump. To guarantee that, on scroll -> rest the client keeps
// the video visible and waits: only once the host's post-motion full-surface tile
// refresh has been applied does it reveal the tiles. That avoids both a black gap
// (tiles not painted yet) and a stale jump (tiles showing pre-scroll content).

enum OwnedMediaMotionState: String, Equatable {
    case rest
    case scrolling
}

enum OwnedMediaVisibleSurface: Equatable {
    case tiles
    case video
}

final class OwnedMediaCarrierHandoff {
    private(set) var visibleSurface: OwnedMediaVisibleSurface = .tiles
    private var awaitingTileRefresh = false

    // True while the video layer is held visible on a scroll->rest transition,
    // waiting for the post-motion tile refresh to commit before revealing tiles.
    var isHoldingVideoForTileRefresh: Bool { awaitingTileRefresh }

    // The host-declared motion-state edge.
    @discardableResult
    func motionStateChanged(to state: OwnedMediaMotionState) -> OwnedMediaVisibleSurface {
        switch state {
        case .scrolling:
            // Entering motion: show video now. Any pending rest hold is abandoned.
            awaitingTileRefresh = false
            visibleSurface = .video
        case .rest:
            // Leaving motion: if video is up, hold it until the refresh commits.
            // If tiles are already showing (never left rest), nothing to do.
            if visibleSurface == .video {
                awaitingTileRefresh = true
            } else {
                visibleSurface = .tiles
            }
        }
        return visibleSurface
    }

    // The post-motion full-surface tile refresh has been applied to the surface.
    // Only now is it safe to reveal tiles, and only if we were holding video for it.
    @discardableResult
    func tileRefreshCommitted() -> OwnedMediaVisibleSurface {
        if awaitingTileRefresh {
            awaitingTileRefresh = false
            visibleSurface = .tiles
        }
        return visibleSurface
    }

    // A fresh surface (reset) returns to the tile baseline with no pending hold.
    func reset() {
        awaitingTileRefresh = false
        visibleSurface = .tiles
    }
}
