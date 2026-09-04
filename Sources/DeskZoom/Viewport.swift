import CoreGraphics

/// Which part of the virtual display (the canvas) the window shows.
/// Canvas coordinates are points with the origin at the top-left.
/// The visible rect always keeps the canvas aspect ratio and stays inside the canvas.
struct Viewport: Equatable {
    /// Smallest visible width in canvas points; caps how far you can zoom in.
    static let minVisibleWidth: CGFloat = 320

    let canvas: CGSize
    private(set) var visible: CGRect

    init(canvas: CGSize) {
        self.canvas = canvas
        self.visible = CGRect(origin: .zero, size: canvas)
    }

    /// 1 when the whole canvas is visible, larger when zoomed in.
    var magnification: CGFloat { canvas.width / visible.width }

    var canZoomIn: Bool { visible.width > Self.minVisibleWidth }
    var canZoomOut: Bool { visible.width < canvas.width }

    /// The canvas point at the middle of what is on screen; the anchor for zoom that is not
    /// driven by a pointer, such as the title bar buttons.
    var center: CGPoint { CGPoint(x: visible.midX, y: visible.midY) }

    mutating func fit() {
        visible = CGRect(origin: .zero, size: canvas)
    }

    /// factor > 1 zooms in. `anchor` is a canvas point that stays under the same screen spot.
    mutating func zoom(by factor: CGFloat, anchor: CGPoint) {
        let newWidth = min(canvas.width, max(Self.minVisibleWidth, visible.width / factor))
        let ratio = newWidth / visible.width
        let origin = CGPoint(
            x: anchor.x - (anchor.x - visible.minX) * ratio,
            y: anchor.y - (anchor.y - visible.minY) * ratio
        )
        let size = CGSize(width: newWidth, height: visible.height * ratio)
        visible = Self.clamp(CGRect(origin: origin, size: size), within: canvas)
    }

    /// Moves the visible rect by `delta` canvas points.
    mutating func pan(by delta: CGVector) {
        visible = Self.clamp(visible.offsetBy(dx: delta.dx, dy: delta.dy), within: canvas)
    }

    /// Pans the least amount needed to bring `point` back inside the visible rect, keeping a margin
    /// expressed as a fraction of the visible size. This is what makes the view follow the cursor while
    /// zoomed in; without it the pointer walks off the edge of the frame and disappears.
    /// No-op when the whole canvas is already visible.
    mutating func follow(_ point: CGPoint, margin: CGFloat) {
        guard canZoomOut else { return }
        let inner = visible.insetBy(dx: visible.width * margin, dy: visible.height * margin)
        var delta = CGVector.zero
        if point.x < inner.minX { delta.dx = point.x - inner.minX }
        if point.x > inner.maxX { delta.dx = point.x - inner.maxX }
        if point.y < inner.minY { delta.dy = point.y - inner.minY }
        if point.y > inner.maxY { delta.dy = point.y - inner.maxY }
        guard delta != .zero else { return }
        pan(by: delta)
    }

    /// The region worth capturing: the visible rect with a margin around it, so a pan of a few points
    /// still lands on pixels the current frame already holds instead of smearing its edge.
    func captureRegion(padding: CGFloat) -> CGRect {
        let whole = CGRect(origin: .zero, size: canvas)
        guard padding > 0, canZoomOut else { return whole }
        return visible.insetBy(dx: -visible.width * padding, dy: -visible.height * padding).intersection(whole)
    }

    /// Where the visible rect sits inside an already-captured region, as the unit rect CALayer wants for
    /// `contentsRect`. This is what makes zooming look instant: the frame on screen is re-cropped straight
    /// away, before a freshly-aimed capture stream has produced anything.
    func contentsRect(forCapturedRegion region: CGRect) -> CGRect {
        guard region.width > 0, region.height > 0 else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
        let raw = CGRect(
            x: (visible.minX - region.minX) / region.width,
            y: (visible.minY - region.minY) / region.height,
            width: visible.width / region.width,
            height: visible.height / region.height
        )
        // Zooming out past what was captured would ask for pixels the frame does not have; CALayer would
        // smear its edge rows. Clamp instead, and let the next frame from the new stream correct it.
        let x = min(max(0, raw.minX), 1)
        let y = min(max(0, raw.minY), 1)
        return CGRect(x: x, y: y, width: min(raw.width, 1 - x), height: min(raw.height, 1 - y))
    }

    /// Maps a fraction of the visible rect (0...1 in each axis, top-left origin) to a canvas point.
    func canvasPoint(atFraction f: CGPoint) -> CGPoint {
        CGPoint(x: visible.minX + f.x * visible.width, y: visible.minY + f.y * visible.height)
    }

    private static func clamp(_ rect: CGRect, within canvas: CGSize) -> CGRect {
        var r = rect
        r.origin.x = min(max(0, r.minX), canvas.width - r.width)
        r.origin.y = min(max(0, r.minY), canvas.height - r.height)
        return r
    }
}
