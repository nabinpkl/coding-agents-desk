import AppKit

@MainActor
final class GesturePortalController: NSObject {
    private let viewController = GesturePortalViewController()
    private var panel: NSPanel?

    var spaceAgentHandleFrame: (() -> CGRect?)?
    var dictationBarFrame: (() -> CGRect?)?
    var terminalLauncherFrame: (() -> CGRect?)?
    var onFrameDidChange: (() -> Void)?

    func start() {
        guard panel == nil else { return }
        let size = viewController.portalSize
        let origin = avoiding(origin: defaultOrigin(size: size), size: size)
        let panel = NSPanel(
            contentRect: CGRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.contentViewController = viewController
        panel.delegate = self
        self.panel = panel
        panel.orderFrontRegardless()
    }

    func stop() {
        panel?.close()
        panel = nil
    }

    func update(_ state: GesturePortalState) {
        viewController.render(state)
        guard let panel else { return }
        let origin = avoiding(origin: panel.frame.origin, size: panel.frame.size)
        guard origin != panel.frame.origin else { return }
        panel.setFrameOrigin(origin)
        onFrameDidChange?()
    }

    func currentScreenFrame() -> CGRect? {
        panel?.frame
    }

    func keepClearOfNeighbors() {
        guard let panel else { return }
        let origin = avoiding(origin: panel.frame.origin, size: panel.frame.size)
        guard origin != panel.frame.origin else { return }
        panel.setFrameOrigin(origin)
        onFrameDidChange?()
    }

    private func defaultOrigin(size: CGSize) -> CGPoint {
        let frame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(
            x: frame.maxX - size.width - 18,
            y: frame.maxY - size.height - 18
        )
    }

    private func avoiding(origin: CGPoint, size: CGSize) -> CGPoint {
        var result = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: origin,
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
        for avoid in [
            spaceAgentHandleFrame?(),
            dictationBarFrame?(),
            terminalLauncherFrame?()
        ].compactMap({ $0 }) {
            result = SpaceAgentPanelPlacement.nonOverlappingOrigin(
                proposed: result,
                size: size,
                avoid: avoid,
                visibleFrames: NSScreen.screens.map(\.visibleFrame)
            )
        }
        return result
    }
}

extension GesturePortalController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        onFrameDidChange?()
    }
}

private final class GesturePortalViewController: NSViewController {
    let portalSize = NSSize(width: 228, height: 178)
    private let portalView = GesturePortalView()

    override func loadView() {
        view = portalView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.frame = CGRect(origin: .zero, size: portalSize)
    }

    func render(_ state: GesturePortalState) {
        portalView.state = state
    }
}

private final class GesturePortalView: NSView {
    var state: GesturePortalState? {
        didSet { needsDisplay = true }
    }

    private let handConnections: [(Int, Int)] = [
        (0, 1), (1, 2), (2, 3), (3, 4),
        (0, 5), (5, 6), (6, 7), (7, 8),
        (5, 9), (9, 10), (10, 11), (11, 12),
        (9, 13), (13, 14), (14, 15), (15, 16),
        (13, 17), (17, 18), (18, 19), (19, 20),
        (0, 17)
    ]

    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let bounds = bounds
        let background = NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9)
        NSColor.windowBackgroundColor.withAlphaComponent(0.50).setFill()
        background.fill()
        NSColor.separatorColor.withAlphaComponent(0.45).setStroke()
        background.lineWidth = 1
        background.stroke()

        guard let state else {
            drawText("GESTURE", at: CGPoint(x: 14, y: bounds.maxY - 28), size: 12, color: .secondaryLabelColor)
            drawText("waiting", at: CGPoint(x: 14, y: bounds.maxY - 50), size: 11, color: .tertiaryLabelColor)
            return
        }

        let portalRect = CGRect(x: 14, y: 18, width: bounds.width - 28, height: 118)
        drawHeader(state, bounds: bounds)
        drawPortalFrame(portalRect)
        drawAnchor(state.anchor, in: portalRect)
        drawHand(state.hand, in: portalRect)
    }

    private func drawHeader(_ state: GesturePortalState, bounds: CGRect) {
        let phaseColor: NSColor = state.anchor?.near == true ? .systemGreen : .labelColor
        drawText(state.phase, at: CGPoint(x: 14, y: bounds.maxY - 25), size: 12, color: phaseColor)
        drawText(
            "L \(state.counts.left)   R \(state.counts.right)",
            at: CGPoint(x: 14, y: bounds.maxY - 45),
            size: 11,
            color: .secondaryLabelColor
        )
    }

    private func drawPortalFrame(_ rect: CGRect) {
        let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        NSColor.black.withAlphaComponent(0.18).setFill()
        path.fill()
        NSColor.separatorColor.withAlphaComponent(0.35).setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    private func drawAnchor(_ anchor: GesturePortalAnchor?, in rect: CGRect) {
        guard let anchor else { return }
        let center = map(anchor.center, in: rect)
        let radiusX = max(6, anchor.radius.x * rect.width)
        let radiusY = max(6, anchor.radius.y * rect.height)
        let ellipseRect = CGRect(
            x: center.x - radiusX,
            y: center.y - radiusY,
            width: radiusX * 2,
            height: radiusY * 2
        )
        if anchor.near {
            let glow = NSBezierPath(ovalIn: ellipseRect.insetBy(dx: -7, dy: -7))
            NSColor.systemGreen.withAlphaComponent(0.24).setFill()
            glow.fill()
        }
        let ellipse = NSBezierPath(ovalIn: ellipseRect)
        NSColor.systemGreen.withAlphaComponent(anchor.near ? 0.95 : 0.62).setStroke()
        ellipse.lineWidth = anchor.near ? 3 : 2
        ellipse.stroke()
    }

    private func drawHand(_ hand: GesturePortalHand?, in rect: CGRect) {
        guard let hand else { return }
        let points = hand.landmarks.map { map($0, in: rect) }
        NSColor.systemTeal.withAlphaComponent(0.85).setStroke()
        for (startIndex, endIndex) in handConnections where startIndex < points.count && endIndex < points.count {
            let path = NSBezierPath()
            path.move(to: points[startIndex])
            path.line(to: points[endIndex])
            path.lineWidth = 1.5
            path.stroke()
        }
        NSColor.systemTeal.setFill()
        for point in points {
            NSBezierPath(ovalIn: CGRect(x: point.x - 2, y: point.y - 2, width: 4, height: 4)).fill()
        }
        let center = map(hand.center, in: rect)
        NSColor.systemYellow.setFill()
        NSBezierPath(ovalIn: CGRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8)).fill()
    }

    private func map(_ point: GesturePortalPoint, in rect: CGRect) -> CGPoint {
        CGPoint(
            x: rect.minX + min(max(point.x, 0), 1) * rect.width,
            y: rect.maxY - min(max(point.y, 0), 1) * rect.height
        )
    }

    private func drawText(_ text: String, at point: CGPoint, size: CGFloat, color: NSColor) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: size, weight: .semibold),
            .foregroundColor: color
        ]
        text.draw(at: point, withAttributes: attributes)
    }
}
