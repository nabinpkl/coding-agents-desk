import KeyboardDictation
import UIKit

@MainActor
final class KeyboardVoiceToolbar: UIView {
    enum Presentation {
        case inactive
        case ready
        case recording(partialTranscript: String?, meter: Float)
        case working(String)
        case reviewing
        case failed(String)
        case unavailable(String)
    }

    var onInsertionModeChanged: ((KeyboardDictationInsertionMode) -> Void)?
    var onVoiceAction: (() -> Void)?
    var onInsertDraft: (() -> Void)?
    var onDismissDraft: (() -> Void)?

    var insertionMode: KeyboardDictationInsertionMode {
        get {
            modeControl.selectedSegmentIndex == 0
                ? .automatic
                : .explicitReview
        }
        set {
            modeControl.selectedSegmentIndex = newValue == .automatic ? 0 : 1
        }
    }

    var isInteractionEnabled: Bool {
        get { actionButton.isEnabled }
        set {
            actionButton.isEnabled = newValue
            modeControl.isEnabled = newValue
        }
    }

    private let statusLabel = UILabel()
    private let meter = UIProgressView(progressViewStyle: .bar)
    private let actionButton = UIButton(type: .system)
    private let modeControl = UISegmentedControl(
        items: ["Auto", "Review"]
    )
    private let insertButton = UIButton(type: .system)
    private let dismissButton = UIButton(type: .system)
    private let linkContainer = UIView()
    private let controls = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        layer.cornerRadius = 10
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.separator.cgColor

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 2
        statusLabel.setContentCompressionResistancePriority(
            .defaultLow,
            for: .horizontal
        )
        meter.isHidden = true
        meter.progressTintColor = .systemBlue
        meter.trackTintColor = .tertiarySystemFill

        actionButton.configuration = .filled()
        actionButton.configuration?.cornerStyle = .capsule
        actionButton.accessibilityLabel = "Start dictation"
        actionButton.addTarget(
            self,
            action: #selector(voiceAction),
            for: .touchUpInside
        )

        modeControl.selectedSegmentIndex = 0
        modeControl.accessibilityLabel = "Dictation insertion mode"
        modeControl.addTarget(
            self,
            action: #selector(modeChanged),
            for: .valueChanged
        )

        insertButton.configuration = .filled()
        insertButton.setTitle("Insert", for: .normal)
        insertButton.accessibilityHint =
            "Inserts the edited transcript into the current text field."
        insertButton.addTarget(
            self,
            action: #selector(insertDraft),
            for: .touchUpInside
        )

        dismissButton.configuration = .plain()
        dismissButton.setTitle("Dismiss", for: .normal)
        dismissButton.addTarget(
            self,
            action: #selector(dismissDraft),
            for: .touchUpInside
        )

        controls.axis = .horizontal
        controls.alignment = .center
        controls.spacing = 8
        controls.addArrangedSubview(statusLabel)
        controls.addArrangedSubview(modeControl)
        controls.addArrangedSubview(actionButton)
        controls.addArrangedSubview(dismissButton)
        controls.addArrangedSubview(insertButton)

        let stack = UIStackView(arrangedSubviews: [
            controls,
            meter,
            linkContainer,
        ])
        stack.axis = .vertical
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
            actionButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
            actionButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            insertButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            dismissButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            modeControl.heightAnchor.constraint(greaterThanOrEqualToConstant: 32),
        ])
        showDraftActions(false)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func render(_ presentation: Presentation) {
        linkContainer.isHidden = true
        meter.isHidden = true
        actionButton.isHidden = false
        switch presentation {
        case .inactive:
            statusLabel.text = "Open AgentDesk once to activate voice."
            actionButton.isHidden = true
        case .ready:
            statusLabel.text = "AgentDesk active"
            actionButton.setImage(UIImage(systemName: "mic.fill"), for: .normal)
            actionButton.accessibilityLabel = "Start dictation"
        case .recording(let transcript, let level):
            statusLabel.text = transcript?.isEmpty == false
                ? transcript
                : "Listening…"
            meter.progress = min(max(level, 0), 1)
            meter.isHidden = false
            actionButton.setImage(UIImage(systemName: "stop.fill"), for: .normal)
            actionButton.accessibilityLabel = "Stop dictation"
        case .working(let message):
            statusLabel.text = message
            actionButton.isHidden = true
        case .reviewing:
            statusLabel.text = "Review transcript"
            actionButton.isHidden = true
        case .failed(let message):
            statusLabel.text = message
            statusLabel.textColor = .systemRed
            actionButton.setImage(UIImage(systemName: "arrow.clockwise"), for: .normal)
            actionButton.accessibilityLabel = "Retry dictation"
        case .unavailable(let message):
            statusLabel.text = message
            statusLabel.textColor = .systemOrange
            actionButton.isHidden = true
        }
        if case .failed = presentation {
            return
        }
        if case .unavailable = presentation {
            return
        }
        statusLabel.textColor = .secondaryLabel
    }

    func installLinkView(_ view: UIView?) {
        linkContainer.subviews.forEach { $0.removeFromSuperview() }
        guard let view else {
            linkContainer.isHidden = true
            return
        }
        linkContainer.isHidden = false
        view.translatesAutoresizingMaskIntoConstraints = false
        linkContainer.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: linkContainer.topAnchor),
            view.leadingAnchor.constraint(equalTo: linkContainer.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: linkContainer.trailingAnchor),
            view.bottomAnchor.constraint(equalTo: linkContainer.bottomAnchor),
            view.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    func showDraftActions(_ visible: Bool) {
        insertButton.isHidden = !visible
        dismissButton.isHidden = !visible
        modeControl.isHidden = visible
        actionButton.isHidden = visible
    }

    @objc private func voiceAction() {
        onVoiceAction?()
    }

    @objc private func modeChanged() {
        onInsertionModeChanged?(insertionMode)
    }

    @objc private func insertDraft() {
        onInsertDraft?()
    }

    @objc private func dismissDraft() {
        onDismissDraft?()
    }
}

@MainActor
final class KeyboardDraftTextView: UITextView {
    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        inputView = UIView(frame: .zero)
        font = .preferredFont(forTextStyle: .body)
        backgroundColor = .secondarySystemBackground
        textColor = .label
        layer.cornerRadius = 8
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.separator.cgColor
        textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        isScrollEnabled = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func setSelectionToEnd() {
        selectedRange = NSRange(location: text.utf16.count, length: 0)
    }

    func insertFromKeyboard(_ insertedText: String) {
        replaceSelection(with: insertedText)
    }

    func deleteFromKeyboard() {
        if selectedRange.length > 0 {
            replaceSelection(with: "")
            return
        }
        guard selectedRange.location > 0 else { return }
        let string = text as NSString
        let prior = string.rangeOfComposedCharacterSequence(
            at: selectedRange.location - 1
        )
        text = string.replacingCharacters(in: prior, with: "")
        selectedRange = NSRange(location: prior.location, length: 0)
    }

    func moveSelection(by delta: Int) {
        let next = min(
            max(selectedRange.location + delta, 0),
            text.utf16.count
        )
        selectedRange = NSRange(location: next, length: 0)
    }

    private func replaceSelection(with replacement: String) {
        let string = text as NSString
        text = string.replacingCharacters(in: selectedRange, with: replacement)
        selectedRange = NSRange(
            location: selectedRange.location + replacement.utf16.count,
            length: 0
        )
    }
}
