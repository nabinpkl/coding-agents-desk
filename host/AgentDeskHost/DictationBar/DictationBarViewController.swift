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

    let preferredPanelSize = CGSize(width: 520, height: 56)

    private let container = NSView()
    private let micButton = PushToTalkButton()
    private let statusLabel = NSTextField(labelWithString: "")

    override func loadView() {
        let root = NSView(frame: CGRect(origin: .zero, size: preferredPanelSize))
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
            statusLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
            statusLabel.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])

        render(.idle)
    }

    func render(_ state: State) {
        switch state {
        case .idle:
            micButton.tint = .systemGray
            statusLabel.textColor = NSColor.white.withAlphaComponent(0.65)
            statusLabel.stringValue = "Hold the mic to talk"
        case .recording:
            micButton.tint = .systemRed
            statusLabel.textColor = .systemRed
            statusLabel.stringValue = "Listening\u{2026}"
        case .transcribing:
            micButton.tint = .systemGray
            statusLabel.textColor = NSColor.white.withAlphaComponent(0.65)
            statusLabel.stringValue = "Transcribing\u{2026}"
        case let .transcript(text):
            micButton.tint = .systemGray
            statusLabel.textColor = .white
            statusLabel.stringValue = text
        case let .message(text):
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
