import AppKit
import CoreImage
import CoreMedia

/// Shows the captured virtual display. Pinch zooms, two-finger scroll pans, click teleports the cursor
/// to the clicked spot on the virtual display so the real windows there receive the following input.
final class CanvasView: NSView {
    /// Extra margin captured around the visible rect, as a fraction of it, so ordinary panning stays inside
    /// what is already captured and needs no new stream. Costs pixels as the square, so it stays modest.
    private static let capturePadding: CGFloat = 0.2
    /// How close to the edge the cursor may get before the view pans to keep up, as a fraction of the view.
    private static let followMargin: CGFloat = 0.18

    private(set) var viewport: Viewport {
        didSet {
            guard viewport != oldValue else { return }
            placeContent()
            onViewportChange?(viewport)
        }
    }
    private let displayID: CGDirectDisplayID
    /// The region of the virtual display each layer's picture covers.
    private var detailRegion: CGRect?
    private var overviewRegion: CGRect?
    private var cursorPollTimer: Timer?
    private var mouseMonitor: Any?
    /// A permanent low-resolution picture of the whole canvas, sitting under the sharp one. Panning and
    /// zooming move faster than a capture stream can be re-aimed, and without something underneath, the
    /// area the sharp capture has not reached yet is bare background: the black the viewer used to show.
    private let overviewLayer = CALayer()
    /// The sharp capture of the region currently being looked at, positioned by frame rather than drawn
    /// with `contentsGravity`. Gravity plus a clamped `contentsRect` letterboxed the picture into black
    /// bars whenever the view moved outside the captured region; placing a layer geometrically cannot.
    private let detailLayer = CALayer()
    private let cursorLayer = CALayer()
    /// A pointer that is not the system's. Nothing on the Mac moves it, so it is drawn here and driven
    /// through the control socket; pressing what sits under it goes through Accessibility, which needs no
    /// pointer at all. That is the only way to point at two places at once on a Mac.
    private let fakeCursorLayer = CAShapeLayer()
    private(set) var fakeCursor: CGPoint?
    private var cursorOnCanvas = false

    var onViewportChange: ((Viewport) -> Void)?
    var onCursorPresenceChange: ((Bool) -> Void)?

    /// Capture can never be sharper than the display it reads. On a 1x virtual display that is one pixel
    /// per point; a HiDPI one renders text at two and is worth asking for.
    var maxPixelsPerPoint: CGFloat = 1

    init(canvas: CGSize, displayID: CGDirectDisplayID, restoring remembered: CGRect?) {
        self.viewport = remembered.map { Viewport(canvas: canvas, restoring: $0) } ?? Viewport(canvas: canvas)
        self.displayID = displayID
        super.init(frame: NSRect(origin: .zero, size: canvas))
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.masksToBounds = true
        layer?.borderWidth = 0
        layer?.borderColor = NSColor.systemBlue.cgColor
        // Each layer's frame is set to exactly the region its pixels cover, so the contents fill it.
        for sublayer in [overviewLayer, detailLayer] {
            sublayer.contentsGravity = .resize
            sublayer.magnificationFilter = .linear
            sublayer.minificationFilter = .trilinear
            sublayer.anchorPoint = .zero
            layer?.addSublayer(sublayer)
        }
        installCursorOverlay()
        installFakeCursor()
        startCursorTracking()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        cursorPollTimer?.invalidate()
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    /// AppKit swallows the first click on an inactive app's window, using it only to activate the app.
    /// Since entering the canvas hands focus away, DeskZoom is usually inactive, and without this every
    /// click into the canvas would be spent on activation and the pointer would not move.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: Frames

    func show(frame: CMSampleBuffer, region: CGRect) {
        guard let surface = Self.surface(of: frame) else { return }
        detailRegion = region
        detailLayer.contents = surface
        placeContent()
    }

    // MARK: Fake cursor

    /// Filled in a colour the system cursor never is, so which of the two is which is never in question.
    private func installFakeCursor() {
        let arrow = CGMutablePath()
        arrow.addLines(between: [
            CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 17), CGPoint(x: 4.4, y: 13.2),
            CGPoint(x: 7.2, y: 19.6), CGPoint(x: 10.4, y: 18.2), CGPoint(x: 7.6, y: 12),
            CGPoint(x: 12.6, y: 11.6),
        ])
        arrow.closeSubpath()
        fakeCursorLayer.path = arrow
        fakeCursorLayer.fillColor = NSColor.systemPink.cgColor
        fakeCursorLayer.strokeColor = NSColor.white.cgColor
        fakeCursorLayer.lineWidth = 1.5
        fakeCursorLayer.lineJoin = .round
        fakeCursorLayer.anchorPoint = .zero
        fakeCursorLayer.bounds = CGRect(x: 0, y: 0, width: 14, height: 20)
        fakeCursorLayer.shadowColor = NSColor.black.cgColor
        fakeCursorLayer.shadowOpacity = 0.35
        fakeCursorLayer.shadowRadius = 2
        fakeCursorLayer.shadowOffset = CGSize(width: 0, height: 1)
        fakeCursorLayer.isHidden = true
        fakeCursorLayer.zPosition = 2
        layer?.addSublayer(fakeCursorLayer)
    }

    /// Moves the fake cursor to a canvas point, bringing it into view if it is off screen, since a pointer
    /// you cannot see is not a pointer.
    func setFakeCursor(_ point: CGPoint?) {
        fakeCursor = point.map {
            CGPoint(x: min(max(0, $0.x), viewport.canvas.width), y: min(max(0, $0.y), viewport.canvas.height))
        }
        if let fakeCursor { viewport.follow(fakeCursor, margin: Self.followMargin) }
        placeFakeCursor()
    }

    private func placeFakeCursor() {
        guard let fakeCursor else {
            fakeCursorLayer.isHidden = true
            return
        }
        let content = contentRect
        let scale = content.width / viewport.visible.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Drawn at a constant size on screen, like a real pointer: it marks a place, it is not part of
        // the picture and must not grow with the zoom.
        fakeCursorLayer.position = CGPoint(
            x: content.minX + (fakeCursor.x - viewport.visible.minX) * scale,
            y: content.minY + (fakeCursor.y - viewport.visible.minY) * scale
        )
        fakeCursorLayer.isHidden = false
        CATransaction.commit()
    }

    /// Drops the sharp picture, leaving the overview alone on screen. Used when the overview turns out to
    /// carry all the detail the window can show, so the sharp stream is stopped.
    func clearDetail() {
        detailRegion = nil
        detailLayer.contents = nil
    }

    /// The whole-canvas picture that fills in wherever the sharp one has not caught up.
    func showOverview(frame: CMSampleBuffer, region: CGRect) {
        guard let surface = Self.surface(of: frame) else { return }
        overviewRegion = region
        overviewLayer.contents = surface
        placeContent()
    }

    /// The overview picture as it stands, for a script that wants the whole canvas without waiting on
    /// another capture. It is whatever frame last arrived, so it is at the overview's resolution and up to
    /// a frame old, which is what "what does the desk look like" needs.
    func overviewImage() -> CGImage? {
        guard overviewRegion != nil, let surface = overviewLayer.contents else { return nil }
        let image = CIImage(ioSurface: surface as! IOSurface)
        return CIContext(options: nil).createCGImage(image, from: image.extent)
    }

    private static func surface(of frame: CMSampleBuffer) -> IOSurface? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame) else { return nil }
        return CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
    }

    /// Puts the frame already on screen exactly where the current viewport says it belongs, so a zoom or a
    /// pan shows immediately instead of waiting for the capture stream to be re-aimed, which on an idle
    /// display could be never. Anything the frame does not cover stays background rather than being faked.
    private func placeContent() {
        guard viewport.visible.width > 0 else { return }
        let content = contentRect
        let scale = content.width / viewport.visible.width
        func rect(for region: CGRect) -> CGRect {
            CGRect(
                x: content.minX + (region.minX - viewport.visible.minX) * scale,
                y: content.minY + (region.minY - viewport.visible.minY) * scale,
                width: region.width * scale,
                height: region.height * scale
            )
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        placeFakeCursor()
        if let overviewRegion { overviewLayer.frame = rect(for: overviewRegion) }
        if let detailRegion {
            detailLayer.frame = rect(for: detailRegion)
            // A sharp picture covering only part of the view is what flicker is: half the window sharp and
            // half of it the overview, the boundary sweeping across as you pan. Either it covers everything
            // being looked at or it is not shown, so the picture always has one sharpness.
            detailLayer.isHidden = !detailRegion.contains(viewport.visible)
        } else {
            detailLayer.isHidden = true
        }
        CATransaction.commit()
    }

    /// The region to capture and the pixel size to capture it at. The pixel budget is set by what the
    /// window can actually show, and never exceeds the source, which at 1x is one pixel per canvas point.
    var capturePlan: CapturePlan {
        let region = viewport.captureRegion(padding: Self.capturePadding)
        let detail = wantedPixelsPerPoint
        return CapturePlan(region: region, pixelSize: CGSize(
            width: max(1, (region.width * detail).rounded()),
            height: max(1, (region.height * detail).rounded())
        ))
    }

    /// How many pixels the whole-canvas capture may use. Generous on purpose: whenever the overview is
    /// already as detailed as the view needs, the sharp capture is not started at all, and panning cannot
    /// flicker because there is nothing to swap between.
    /// 17 megapixels covers 2560x1600 at two pixels per point, and 5120x3200 at one, entirely: those rungs
    /// then never start a second stream at all. It is about what capturing a 5K display natively costs.
    static let overviewPixelBudget: CGFloat = 17_000_000

    /// Pixel size for the whole-canvas overview: as much detail as the budget allows, never more than the
    /// display itself holds.
    static func overviewPixelSize(for canvas: CGSize, pixelsPerPoint: CGFloat) -> CGSize {
        guard canvas.width > 0, canvas.height > 0 else { return CGSize(width: 1, height: 1) }
        let full = CGSize(width: canvas.width * pixelsPerPoint, height: canvas.height * pixelsPerPoint)
        let scale = min(1, (overviewPixelBudget / (full.width * full.height)).squareRoot())
        return CGSize(width: (full.width * scale).rounded(), height: (full.height * scale).rounded())
    }

    /// Capture pixels per canvas point: what the window can actually show, capped at the source's own
    /// resolution, which on a 1x virtual display is one pixel per point.
    var wantedPixelsPerPoint: CGFloat {
        let scale = window?.backingScaleFactor ?? 2
        return min(contentRect.width * scale / max(1, viewport.visible.width), maxPixelsPerPoint)
    }

    /// Detail the whole-canvas capture provides, per canvas point.
    var overviewPixelsPerPoint: CGFloat {
        let size = Self.overviewPixelSize(for: viewport.canvas, pixelsPerPoint: maxPixelsPerPoint)
        return viewport.canvas.width > 0 ? size.width / viewport.canvas.width : 0
    }

    /// Whether a second, sharper capture of the visible region is worth running at all. When the overview
    /// already carries the detail the window can show, it is not: one stream covers everything, no region
    /// is ever re-aimed, and panning has nothing to swap between.
    var needsDetailCapture: Bool {
        wantedPixelsPerPoint > overviewPixelsPerPoint * 1.08
    }

    /// Whether a running capture still serves the current viewport, so the app can skip the expensive
    /// re-aim while the view is merely panning inside what it already captured.
    func isServed(by plan: CapturePlan?) -> Bool {
        plan?.satisfies(visible: viewport.visible, pixelsPerPoint: wantedPixelsPerPoint, shortfall: 0.92, surplus: 2.2) ?? false
    }

    /// The part of the view the aspect-fitted frame occupies.
    var contentRect: CGRect {
        let aspect = viewport.canvas.width / viewport.canvas.height
        var size = bounds.size
        if size.width / size.height > aspect {
            size.width = size.height * aspect
        } else {
            size.height = size.width / aspect
        }
        return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }

    override func layout() {
        super.layout()
        placeContent()
        onViewportChange?(viewport)
    }

    // MARK: Gestures

    override func magnify(with event: NSEvent) {
        guard let anchor = canvasPoint(at: convert(event.locationInWindow, from: nil)) else { return }
        viewport.zoom(by: 1 + event.magnification, anchor: anchor)
    }

    override func scrollWheel(with event: NSEvent) {
        let canvasPerViewPoint = viewport.visible.width / contentRect.width
        viewport.pan(by: CGVector(
            dx: -event.scrollingDeltaX * canvasPerViewPoint,
            dy: -event.scrollingDeltaY * canvasPerViewPoint
        ))
    }

    override func mouseDown(with event: NSEvent) {
        guard let point = canvasPoint(at: convert(event.locationInWindow, from: nil)) else { return }
        CGDisplayMoveCursorToPoint(displayID, point)
        // Clicking this window has just made DeskZoom the active app, on the built-in screen, which is
        // where macOS would then open anything launched from Spotlight. Hand focus to whatever the pointer
        // now sits on instead, so the canvas becomes the active display.
        let origin = CGDisplayBounds(displayID).origin
        CanvasFocus.activate(at: CGPoint(x: origin.x + point.x, y: origin.y + point.y))
    }

    func fit() {
        viewport.fit()
    }

    /// Starts again on a canvas of a different size, after the display has been moved to another rung.
    /// The pictures on screen belong to the old canvas and would be placed wrongly on the new one, so they
    /// go, and the viewer shows the whole of the new canvas until the captures catch up.
    func adopt(canvas: CGSize, pixelsPerPoint: CGFloat) {
        maxPixelsPerPoint = pixelsPerPoint
        detailRegion = nil
        overviewRegion = nil
        detailLayer.contents = nil
        overviewLayer.contents = nil
        viewport = Viewport(canvas: canvas)
    }

    /// Zoom driven by something other than the pointer (title bar buttons, menu shortcuts),
    /// so it keeps whatever is in the middle of the view in the middle.
    /// Shows the canvas at its own size: one canvas point per window point. Text is then exactly the size
    /// and sharpness it has on the display itself. Fitting the whole canvas cannot match that, because a
    /// canvas wider than the window is shrunk to fit, and shrunk text is soft however many pixels back it.
    func actualSize() {
        guard contentRect.width > 0, viewport.visible.width > 0 else { return }
        viewport.zoom(by: viewport.visible.width / contentRect.width, anchor: viewport.center)
    }

    func zoomAroundCenter(by factor: CGFloat) {
        viewport.zoom(by: factor, anchor: viewport.center)
    }

    /// Zoom from a pinch made while the pointer is on the virtual display, anchored under the pointer
    /// so the thing being pinched stays put. Ignored when the pointer has since left the canvas.
    func zoomAtCursor(by factor: CGFloat) {
        guard let point = cursorCanvasPoint() else { return }
        viewport.zoom(by: factor, anchor: point)
    }

    /// Where the pointer is in canvas points, or nil when it is not on the virtual display.
    private func cursorCanvasPoint() -> CGPoint? {
        guard let frame = NSScreen.screens.first(where: { $0.displayID == displayID })?.frame else { return nil }
        let location = NSEvent.mouseLocation
        guard NSMouseInRect(location, frame, false) else { return nil }
        // AppKit global coordinates have a bottom-left origin; the canvas uses top-left.
        return CGPoint(x: location.x - frame.minX, y: frame.maxY - location.y)
    }

    private func canvasPoint(at viewPoint: CGPoint) -> CGPoint? {
        let content = contentRect
        let fraction = CGPoint(
            x: (viewPoint.x - content.minX) / content.width,
            y: (viewPoint.y - content.minY) / content.height
        )
        guard (0...1).contains(fraction.x), (0...1).contains(fraction.y) else { return nil }
        return viewport.canvasPoint(atFraction: fraction)
    }

    // MARK: Cursor

    /// The capture stream omits the cursor; this layer draws the real one at the mapped spot with no capture lag.
    private func installCursorOverlay() {
        let cursor = NSCursor.arrow
        let image = cursor.image
        var rect = CGRect(origin: .zero, size: image.size)
        cursorLayer.contents = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
        cursorLayer.bounds = CGRect(origin: .zero, size: image.size)
        cursorLayer.anchorPoint = CGPoint(x: cursor.hotSpot.x / image.size.width, y: cursor.hotSpot.y / image.size.height)
        cursorLayer.isHidden = true
        cursorLayer.zPosition = 1
        layer?.addSublayer(cursorLayer)
    }

    /// Global mouse events arrive at the input rate, so the overlay is redrawn as fast as the hand moves.
    /// The timer covers presence changes that produce no event, such as a programmatic cursor warp.
    private func startCursorTracking() {
        let moved: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: moved) { [weak self] _ in
            self?.refreshCursor()
        }
        cursorPollTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.refreshCursor()
        }
    }

    private func refreshCursor() {
        let location = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.displayID == displayID }
        let present = screen.map { NSMouseInRect(location, $0.frame, false) } ?? false
        if present != cursorOnCanvas {
            cursorOnCanvas = present
            layer?.borderWidth = present ? 3 : 0
            onCursorPresenceChange?(present)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard present, let frame = screen?.frame else {
            cursorLayer.isHidden = true
            return
        }
        // AppKit global coordinates have a bottom-left origin; the canvas uses top-left.
        let canvasPoint = CGPoint(x: location.x - frame.minX, y: frame.maxY - location.y)
        viewport.follow(canvasPoint, margin: Self.followMargin)
        let visible = viewport.visible
        let content = contentRect
        let viewPoint = CGPoint(
            x: content.minX + (canvasPoint.x - visible.minX) / visible.width * content.width,
            y: content.minY + (canvasPoint.y - visible.minY) / visible.height * content.height
        )
        cursorLayer.isHidden = !content.contains(viewPoint)
        cursorLayer.position = viewPoint
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID? {
        deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
    }
}
