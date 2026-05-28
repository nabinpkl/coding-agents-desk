import AppKit

@MainActor
protocol DictationBarViewControllerDelegate: AnyObject {
    func dictationBarDidPressTalk(_ controller: DictationBarViewController)
    func dictationBarDidReleaseTalk(_ controller: DictationBarViewController)
}

@MainActor
final class DictationBarViewController: NSViewController {
    enum State {
        case idle
        case recording
        case transcribing
        case transcript(String)
        case message(String)
    }

    weak var delegate: DictationBarViewControllerDelegate?

    // Resting state is a mic-only pill; it widens to show the meter or text.
    let compactSize = CGSize(width: 60, height: 52)
    let expandedSize = CGSize(width: 520, height: 52)

    private let container = NSView()
    private let micButton = PushToTalkButton()
    private let statusLabel = NSTextField(labelWithString: "")
    private let levelMeter = LevelMeterView()

    override func loadView() {
        let root = NSView(frame: CGRect(origin: .zero, size: compactSize))
        view = root

        container.wantsLayer = true
        container.layer?.cornerRadius = 16
        container.layer?.backgroundColor = NSColor(calibratedWhite: 0.10, alpha: 0.92).cgColor
        container.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(container)

        micButton.translatesAutoresizingMaskIntoConstraints = false
        micButton.onPress = { [weak self] in
            guard let self else { return }
            self.delegate?.dictationBarDidPressTalk(self)
        }
        micButton.onRelease = { [weak self] in
            guard let self else { return }
            self.delegate?.dictationBarDidReleaseTalk(self)
        }
        container.addSubview(micButton)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 13, weight: .regular)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.maximumNumberOfLines = 2
        statusLabel.cell?.truncatesLastVisibleLine = true
        container.addSubview(statusLabel)

        levelMeter.translatesAutoresizingMaskIntoConstraints = false
        levelMeter.isHidden = true
        container.addSubview(levelMeter)

        // Trailing edges only matter while expanded; drop their priority so
        // the compact (mic-only) width does not break a required constraint
        // against the hidden label and meter.
        let labelTrailing = statusLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16)
        labelTrailing.priority = .defaultHigh
        let meterTrailing = levelMeter.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16)
        meterTrailing.priority = .defaultHigh

        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            container.topAnchor.constraint(equalTo: root.topAnchor),
            container.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            micButton.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            micButton.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            micButton.widthAnchor.constraint(equalToConstant: 36),
            micButton.heightAnchor.constraint(equalToConstant: 36),

            statusLabel.leadingAnchor.constraint(equalTo: micButton.trailingAnchor, constant: 12),
            labelTrailing,
            statusLabel.centerYAnchor.constraint(equalTo: container.centerYAnchor),

            levelMeter.leadingAnchor.constraint(equalTo: micButton.trailingAnchor, constant: 12),
            meterTrailing,
            levelMeter.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            levelMeter.heightAnchor.constraint(equalToConstant: 22),
        ])

        render(.idle)
    }

    // Forwards the recorder's peak level (0...1) to the meter. Only has a
    // visible effect while the meter is shown (the .recording state).
    func updateLevel(_ level: Float) {
        levelMeter.level = level
    }

    // Whether the bar needs its widened size for this state (meter or text).
    // Idle is the compact, mic-only resting state.
    static func isExpanded(_ state: State) -> Bool {
        if case .idle = state { return false }
        return true
    }

    func render(_ state: State) {
        switch state {
        case .idle:
            levelMeter.isHidden = true
            levelMeter.level = 0
            statusLabel.isHidden = true
            micButton.tint = .systemGray
        case .recording:
            levelMeter.isHidden = false
            statusLabel.isHidden = true
            micButton.tint = .systemRed
        case .transcribing:
            levelMeter.isHidden = true
            levelMeter.level = 0
            statusLabel.isHidden = false
            micButton.tint = .systemGray
            statusLabel.textColor = NSColor.white.withAlphaComponent(0.65)
            statusLabel.stringValue = "Transcribing\u{2026}"
        case let .transcript(text):
            levelMeter.isHidden = true
            levelMeter.level = 0
            statusLabel.isHidden = false
            micButton.tint = .systemGray
            statusLabel.textColor = .white
            statusLabel.stringValue = text
        case let .message(text):
            levelMeter.isHidden = true
            levelMeter.level = 0
            statusLabel.isHidden = false
            micButton.tint = .systemGray
            statusLabel.textColor = .systemOrange
            statusLabel.stringValue = text
        }
    }
}

// Push-to-talk control. mouseDown starts, mouseUp stops. acceptsFirstMouse
// returns true so a press lands even when the borderless non-activating
// panel is not the key window (the common case for an always-on overlay).
@MainActor
final class PushToTalkButton: NSView {
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?
    var tint: NSColor = .systemGray {
        didSet { needsDisplay = true }
    }

    private var isPressed = false

    override var acceptsFirstResponder: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        isPressed = true
        needsDisplay = true
        onPress?()
    }

    override func mouseUp(with event: NSEvent) {
        guard isPressed else { return }
        isPressed = false
        needsDisplay = true
        onRelease?()
    }

    override func draw(_ dirtyRect: NSRect) {
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1))
        (isPressed ? tint.withAlphaComponent(0.85) : tint.withAlphaComponent(0.25)).setFill()
        circle.fill()

        let symbolConfig = NSImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
        guard let image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Push to talk")?
            .withSymbolConfiguration(symbolConfig) else { return }
        let tinted = image
        tinted.isTemplate = true
        let imgSize = tinted.size
        let origin = NSPoint(x: bounds.midX - imgSize.width / 2, y: bounds.midY - imgSize.height / 2)
        tint.set()
        tinted.draw(at: origin, from: .zero, operation: .sourceOver, fraction: 1.0)
    }
}

// Classic segmented audio meter. Bars rise left to right and light up to
// the current peak level, turning amber then red near the top so clipping
// reads at a glance. Light smoothing keeps fast peaks from flickering.
@MainActor
final class LevelMeterView: NSView {
    var level: Float = 0 {
        didSet {
            let target = min(max(level, 0), 1)
            displayed += (target - displayed) * 0.5
            needsDisplay = true
        }
    }

    private var displayed: Float = 0

    override func draw(_ dirtyRect: NSRect) {
        let gap: CGFloat = 3
        let count = max(8, Int(bounds.width / 9))
        let barWidth = (bounds.width - CGFloat(count - 1) * gap) / CGFloat(count)
        guard barWidth > 0 else { return }
        let lit = Int((CGFloat(displayed) * CGFloat(count)).rounded())

        for i in 0..<count {
            let fraction = count > 1 ? CGFloat(i) / CGFloat(count - 1) : 0
            let height = bounds.height * (0.35 + 0.65 * fraction)
            let rect = NSRect(
                x: CGFloat(i) * (barWidth + gap),
                y: (bounds.height - height) / 2,
                width: barWidth,
                height: height
            )
            let path = NSBezierPath(roundedRect: rect, xRadius: barWidth / 2, yRadius: barWidth / 2)
            if i < lit {
                color(forFraction: fraction).setFill()
            } else {
                NSColor.white.withAlphaComponent(0.12).setFill()
            }
            path.fill()
        }
    }

    private func color(forFraction fraction: CGFloat) -> NSColor {
        if fraction > 0.85 { return .systemRed }
        if fraction > 0.6 { return .systemYellow }
        return .systemGreen
    }
}
