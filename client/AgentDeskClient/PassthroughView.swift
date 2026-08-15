import UIKit

/// A container that occupies its parent entirely but is invisible to touches.
///
/// The `HostContentStage` bands are all full-bleed and stacked on each other, so
/// without this the topmost one would swallow every touch aimed at the bands
/// beneath it: UIKit's default `hitTest` returns the container itself when no
/// subview claims the point. Returning nil instead lets the hit fall through to
/// the next band down, which is what "these are z-order bands, not panels" has
/// to mean.
///
/// A hidden or non-interactive subview is skipped by `super.hitTest` already, so
/// a band whose contents are all hidden is fully transparent to touches with no
/// bookkeeping at the mount sites.
///
/// Its own file, with no reference to the view controller, so it compiles into
/// the test target -- everything else about the bands is pure, and this is the
/// one piece with behavior worth pinning.
final class PassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}
