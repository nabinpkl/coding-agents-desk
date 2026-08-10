import CoreGraphics

// Resting layout of the Spaces strip's tile row, derived from the row's own numbers rather
// than read back from the flow layout.
//
// The strip opens by animating its height, and a flow layout interrogated during that
// animation answers from a collection view that is still the closed height. Waiting for the
// animation to land fixes the answer but costs a visible beat before the selection indicator
// appears. Every input here is known before the first pixel moves -- tile size, spacing,
// count, and the viewport width, which does not participate in the height animation -- so the
// indicator can be placed on the active tile up front and simply be revealed in position.
//
// This mirrors what UICollectionViewFlowLayout does for a horizontal section with a uniform
// itemSize: `sectionInset` is the value handed to the layout, so the two cannot disagree.
struct ThumbnailStripGeometry {
    let tileCount: Int
    let tileWidth: CGFloat
    let tileHeight: CGFloat
    let spacing: CGFloat
    // Width of the scrolling window: the tile row's container, which excludes the chevron
    // column. Fixed by constraints, so it is already correct while the strip is still closed.
    let viewportWidth: CGFloat

    var rowWidth: CGFloat {
        guard tileCount > 0 else { return 0 }
        return CGFloat(tileCount) * tileWidth + CGFloat(tileCount - 1) * spacing
    }

    // Equal leading/trailing inset centring the row while it fits, collapsing to zero the
    // moment it overflows and the row starts scrolling instead.
    var sectionInset: CGFloat { max(0, (viewportWidth - rowWidth) / 2) }

    var contentWidth: CGFloat { rowWidth + sectionInset * 2 }

    // Zero whenever the row fits, since the inset pads content out to exactly the viewport.
    var maxOffsetX: CGFloat { max(0, contentWidth - viewportWidth) }

    var isUsable: Bool { tileCount > 0 && viewportWidth > 0 && tileWidth > 0 }

    // Tile frame in content coordinates.
    func tileFrame(at index: Int) -> CGRect {
        CGRect(
            x: sectionInset + CGFloat(index) * (tileWidth + spacing),
            y: 0,
            width: tileWidth,
            height: tileHeight
        )
    }

    // Offset at which the tile comes to rest centred in the viewport, clamped to the
    // scrollable range the collection view would clamp to anyway.
    func restingOffsetX(for index: Int) -> CGFloat {
        min(max(0, tileFrame(at: index).midX - viewportWidth / 2), maxOffsetX)
    }

    // Tile frame in the container's coordinates for a given scroll offset. The selection
    // indicator is a sibling of the collection view, so it is positioned from this rather
    // than from content coordinates.
    func tileFrame(at index: Int, offsetBy offsetX: CGFloat) -> CGRect {
        tileFrame(at: index).offsetBy(dx: -offsetX, dy: 0)
    }
}
