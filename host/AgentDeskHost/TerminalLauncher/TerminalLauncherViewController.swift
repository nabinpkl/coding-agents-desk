import AppKit

@MainActor
protocol TerminalLauncherViewControllerDelegate: AnyObject {
    func terminalLauncherDidActivate(_ controller: TerminalLauncherViewController)
}

// A single round pill that launches a terminal when clicked. Sibling of the
// SpaceAgent handle and the dictation bar: same 52pt pill, same translucent
// surface and gray-disc-behind-icon look, so the three floating overlays read
// as one family. Unlike the dictation mic this is a plain click (not press-and-
// hold), so it carries no recording semantics.
@MainActor
final class TerminalLauncherViewController: NSViewController {
    weak var delegate: TerminalLauncherViewControllerDelegate?

    let pillSize = CGSize(width: 52, height: 52)

    private let pill = TerminalPillView()
    private let button = TerminalButton()

    override func loadView() {
        let root = NSView(frame: CGRect(origin: .zero, size: pillSize))
        root.wantsLayer = true
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(pill)
        pill.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pill.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pill.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pill.topAnchor.constraint(equalTo: view.topAnchor),
            pill.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            view.widthAnchor.constraint(equalToConstant: pillSize.width),
            view.heightAnchor.constraint(equalToConstant: pillSize.height)
        ])

        pill.addSubview(button)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.target = self
        button.action = #selector(buttonClicked)
        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: pill.centerXAnchor),
            button.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            button.widthAnchor.constraint(equalToConstant: 36),
            button.heightAnchor.constraint(equalToConstant: 36)
        ])
    }

    @objc private func buttonClicked() {
        delegate?.terminalLauncherDidActivate(self)
    }
}

// Same translucent pill surface as DictationPillView / SpaceAgentHandleView:
// near-white in light mode, near-black in dark mode, with a hairline border.
private final class TerminalPillView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let bounds = self.bounds
        let radius = bounds.height / 2

        let surface: NSColor = isDark
            ? NSColor(calibratedWhite: 0.06, alpha: 0.72)
            : NSColor(calibratedWhite: 1.0, alpha: 0.95)
        surface.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()

        let hairline: NSColor = isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.16)
            : NSColor(calibratedWhite: 0.0, alpha: 0.10)
        hairline.setStroke()
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let stroke = NSBezierPath(roundedRect: inset, xRadius: radius, yRadius: radius)
        stroke.lineWidth = 1
        stroke.stroke()
    }
}

// The ">_" prompt mark on a gray disc (light) or directly on the dark pill,
// mirroring the dictation mic. The art carries light/dark appearance variants
// in TerminalPrompt.imageset, so NSImage(named:) resolves the slot at draw time.
private final class TerminalButton: NSButton {
    private var pressed = false {
        didSet { needsDisplay = true }
    }
    private let art = NSImage(named: "TerminalPrompt")
    // Where the press began, in window coordinates, so a press that turns into
    // a drag past a small threshold moves the panel instead of launching.
    private var mouseDownLocation: NSPoint = .zero
    private var dragging = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        isBordered = false
        title = ""
        wantsLayer = true
    }

    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let bounds = self.bounds

        if !isDark {
            NSColor.systemGray.withAlphaComponent(0.25).setFill()
            NSBezierPath(ovalIn: bounds).fill()
        }

        guard let art else { return }
        let inset = bounds.insetBy(dx: 8, dy: 8)
        art.draw(in: inset, from: .zero, operation: .sourceOver, fraction: pressed ? 0.6 : 1)
    }

    override func mouseDown(with event: NSEvent) {
        pressed = true
        dragging = false
        mouseDownLocation = event.locationInWindow
    }

    // Once the press moves past a small threshold, hand the gesture to the
    // window so the pill drags like the SpaceAgent handle and dictation bar.
    // performDrag runs its own loop until mouseUp, so no launch follows.
    override func mouseDragged(with event: NSEvent) {
        guard !dragging else { return }
        let dx = event.locationInWindow.x - mouseDownLocation.x
        let dy = event.locationInWindow.y - mouseDownLocation.y
        if dx * dx + dy * dy > 9 {
            dragging = true
            pressed = false
            window?.performDrag(with: event)
        }
    }

    override func mouseUp(with event: NSEvent) {
        let wasInside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        if !dragging && wasInside {
            sendAction(action, to: target)
        }
        dragging = false
    }
}
