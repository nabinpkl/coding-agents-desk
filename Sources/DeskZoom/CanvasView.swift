import AppKit
import CoreMedia

/// Shows the captured virtual display. Pinch zooms, two-finger scroll pans, click teleports the cursor
/// to the clicked spot on the virtual display so the real windows there receive the following input.
final class CanvasView: NSView {
    /// Extra margin captured around the visible rect, as a fraction of it, so short pans stay on real pixels.
    private static let capturePadding: CGFloat = 0.1
    /// How close to the edge the cursor may get before the view pans to keep up, as a fraction of the view.
    private static let followMargin: CGFloat = 0.18

    private(set) var viewport: Viewport {
        didSet {
            guard viewport != oldValue else { return }
            applyContentsRect()
            onViewportChange?(viewport)
        }
    }
    private let displayID: CGDirectDisplayID
    private var currentFrame: CMSampleBuffer?
    /// The region of the virtual display the frame on screen actually covers.
    private var frameRegion: CGRect?
    private var cursorPollTimer: Timer?
    private var mouseMonitor: Any?
    private let cursorLayer = CALayer()
    private var cursorOnCanvas = false

    var onViewportChange: ((Viewport) -> Void)?
    var onCursorPresenceChange: ((Bool) -> Void)?

    init(canvas: CGSize, displayID: CGDirectDisplayID) {
        self.viewport = Viewport(canvas: canvas)
        self.displayID = displayID
        super.init(frame: NSRect(origin: .zero, size: canvas))
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.contentsGravity = .resizeAspect
        layer?.magnificationFilter = .linear
        layer?.minificationFilter = .trilinear
        layer?.borderWidth = 0
        layer?.borderColor = NSColor.systemBlue.cgColor
        installCursorOverlay()
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

    // MARK: Frames

    func show(frame: CMSampleBuffer, region: CGRect) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame),
              let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        else { return }
        currentFrame = frame
        frameRegion = region
        layer?.contents = surface
        applyContentsRect()
    }

    /// Re-crops the frame already on screen to the current viewport, so a zoom shows immediately instead of
    /// waiting for the capture stream to be re-aimed, which on an idle display could be never.
    private func applyContentsRect() {
        guard let region = frameRegion else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer?.contentsRect = viewport.contentsRect(forCapturedRegion: region)
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

    /// Capture pixels per canvas point: what the window can actually show, capped at the source's own
    /// resolution, which on a 1x virtual display is one pixel per point.
    var wantedPixelsPerPoint: CGFloat {
        let scale = window?.backingScaleFactor ?? 2
        return min(contentRect.width * scale / max(1, viewport.visible.width), 1)
    }

    /// Whether a running capture still serves the current viewport, so the app can skip the expensive
    /// re-aim while the view is merely panning inside what it already captured.
    func isServed(by plan: CapturePlan?) -> Bool {
        plan?.satisfies(visible: viewport.visible, pixelsPerPoint: wantedPixelsPerPoint, tolerance: 0.35) ?? false
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
        applyContentsRect()
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
    }

    func fit() {
        viewport.fit()
    }

    /// Zoom driven by something other than the pointer (title bar buttons, menu shortcuts),
    /// so it keeps whatever is in the middle of the view in the middle.
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
