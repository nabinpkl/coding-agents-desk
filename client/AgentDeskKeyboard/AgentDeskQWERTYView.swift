import KeyboardDictation
import UIKit

struct KeyboardReturnKeyPresentation: Equatable {
    enum Visual: Equatable {
        case title(String)
        case systemImage(String)
    }

    let visual: Visual
    let accessibilityLabel: String

    static let `default` = KeyboardReturnKeyPresentation(
        visual: .title("↵"),
        accessibilityLabel: "Return"
    )

    init(returnKeyType: UIReturnKeyType?) {
        switch returnKeyType {
        case .go:
            self.init(
                visual: .systemImage("arrow.forward"),
                accessibilityLabel: "Go"
            )
        case .google:
            self.init(
                visual: .systemImage("magnifyingglass"),
                accessibilityLabel: "Google"
            )
        case .join:
            self.init(
                visual: .systemImage("arrow.forward"),
                accessibilityLabel: "Join"
            )
        case .next:
            self.init(
                visual: .systemImage("chevron.forward"),
                accessibilityLabel: "Next"
            )
        case .route:
            self.init(
                visual: .systemImage("arrow.forward"),
                accessibilityLabel: "Route"
            )
        case .search:
            self.init(
                visual: .systemImage("magnifyingglass"),
                accessibilityLabel: "Search"
            )
        case .send:
            self.init(
                visual: .systemImage("arrow.up"),
                accessibilityLabel: "Send"
            )
        case .yahoo:
            self.init(
                visual: .systemImage("magnifyingglass"),
                accessibilityLabel: "Yahoo"
            )
        case .done:
            self.init(
                visual: .systemImage("checkmark"),
                accessibilityLabel: "Done"
            )
        case .emergencyCall:
            self.init(
                visual: .systemImage("phone"),
                accessibilityLabel: "Emergency Call"
            )
        case .continue:
            self.init(
                visual: .systemImage("chevron.forward"),
                accessibilityLabel: "Continue"
            )
        case .default, nil:
            self = .default
        @unknown default:
            self = .default
        }
    }

    private init(visual: Visual, accessibilityLabel: String) {
        self.visual = visual
        self.accessibilityLabel = accessibilityLabel
    }
}

@MainActor
protocol KeyboardRepeatScheduling: AnyObject {
    func start(
        after initialDelay: Duration,
        every interval: Duration,
        action: @escaping @MainActor () -> Void
    )
    func stop()
}

@MainActor
final class TaskKeyboardRepeatScheduler: KeyboardRepeatScheduling {
    private var task: Task<Void, Never>?

    deinit {
        task?.cancel()
    }

    func start(
        after initialDelay: Duration,
        every interval: Duration,
        action: @escaping @MainActor () -> Void
    ) {
        stop()
        task = Task { @MainActor in
            do {
                try await Task.sleep(for: initialDelay)
                while !Task.isCancelled {
                    action()
                    try await Task.sleep(for: interval)
                }
            } catch is CancellationError {
                return
            } catch {
                assertionFailure("Keyboard repeat scheduler failed: \(error)")
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}

@MainActor
final class AgentDeskQWERTYView: UIView, UIInputViewAudioFeedback {
    var onKey: ((KeyboardKey) -> Void)?
    var onDelete: (() -> Void)?
    var onDeleteEnded: (() -> Void)?
    var onCursorDelta: ((Int) -> Void)?
    var configureInputModeSwitchKey: ((UIButton) -> Void)?
    var hapticsEnabled = true
    var returnKeyPresentation = KeyboardReturnKeyPresentation.default {
        didSet {
            if returnKeyPresentation != oldValue {
                renderedState = nil
            }
        }
    }

    var enableInputClicksWhenVisible: Bool { true }

    private let rowsStack = UIStackView()
    private let characterPreview = KeyboardCharacterPreviewView()
    private let feedback: KeyboardFeedbackProviding
    private var metrics = KeyboardDeckMetrics.portrait
    private var renderedState: KeyboardLayoutState?
    private var requestedState: KeyboardLayoutState?
    private var rowsTopConstraint: NSLayoutConstraint!
    private var rowsLeadingConstraint: NSLayoutConstraint!
    private var rowsTrailingConstraint: NSLayoutConstraint!
    private var rowsBottomConstraint: NSLayoutConstraint!
    private weak var characterPreviewOwner: KeyboardKeyButton?

    init(
        frame: CGRect = .zero,
        feedback: KeyboardFeedbackProviding = SystemKeyboardFeedbackEngine()
    ) {
        self.feedback = feedback
        super.init(frame: frame)
        backgroundColor = .clear
        clipsToBounds = false
        rowsStack.axis = .vertical
        rowsStack.distribution = .fill
        rowsStack.spacing = metrics.verticalRowGap
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rowsStack)
        addSubview(characterPreview)

        rowsTopConstraint = rowsStack.topAnchor.constraint(
            equalTo: topAnchor,
            constant: metrics.topDeckPadding
        )
        rowsLeadingConstraint = rowsStack.leadingAnchor.constraint(
            equalTo: leadingAnchor,
            constant: metrics.horizontalDeckInset
        )
        rowsTrailingConstraint = rowsStack.trailingAnchor.constraint(
            equalTo: trailingAnchor,
            constant: -metrics.horizontalDeckInset
        )
        rowsBottomConstraint = rowsStack.bottomAnchor.constraint(
            equalTo: bottomAnchor,
            constant: -metrics.bottomDeckPadding
        )
        NSLayoutConstraint.activate([
            rowsTopConstraint,
            rowsLeadingConstraint,
            rowsTrailingConstraint,
            rowsBottomConstraint,
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ metrics: KeyboardDeckMetrics) {
        guard self.metrics != metrics else { return }
        self.metrics = metrics
        rowsStack.spacing = metrics.verticalRowGap
        rowsTopConstraint.constant = metrics.topDeckPadding
        rowsLeadingConstraint.constant = metrics.horizontalDeckInset
        rowsTrailingConstraint.constant = -metrics.horizontalDeckInset
        rowsBottomConstraint.constant = -metrics.bottomDeckPadding
        renderedState = nil
        if let requestedState {
            render(requestedState)
        }
    }

    func render(_ state: KeyboardLayoutState) {
        requestedState = state
        guard renderedState != state else { return }
        dismissCharacterPreview()
        renderedState = state
        rowsStack.arrangedSubviews.forEach {
            rowsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        var alphabetCharacterWidthReference: KeyboardKeyButton?
        for (rowIndex, keys) in state.rows.enumerated() {
            let row = makeRow(
                keys,
                rowIndex: rowIndex,
                state: state
            )
            rowsStack.addArrangedSubview(row.view)
            if rowIndex == 0, state.page == .alphabet {
                alphabetCharacterWidthReference = row.widthReference
            } else if rowIndex == 1,
                      state.page == .alphabet,
                      let widthReference = row.widthReference,
                      let alphabetCharacterWidthReference
            {
                widthReference.widthAnchor.constraint(
                    equalTo: alphabetCharacterWidthReference.widthAnchor
                ).isActive = true
            }
        }
    }

    private func makeRow(
        _ keys: [KeyboardKey],
        rowIndex: Int,
        state: KeyboardLayoutState
    ) -> (view: UIView, widthReference: KeyboardKeyButton?) {
        let container = UIView()
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fill
        stack.spacing = metrics.horizontalKeyGap
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)

        let centersAlphabetHomeRow =
            rowIndex == 1 && state.page == .alphabet
        var constraints = [
            container.heightAnchor.constraint(
                equalToConstant: metrics.keycapHeight
            ),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ]
        if centersAlphabetHomeRow {
            constraints += [
                stack.centerXAnchor.constraint(
                    equalTo: container.centerXAnchor
                ),
                stack.leadingAnchor.constraint(
                    greaterThanOrEqualTo: container.leadingAnchor
                ),
                stack.trailingAnchor.constraint(
                    lessThanOrEqualTo: container.trailingAnchor
                ),
            ]
        } else {
            constraints += [
                stack.leadingAnchor.constraint(
                    equalTo: container.leadingAnchor
                ),
                stack.trailingAnchor.constraint(
                    equalTo: container.trailingAnchor
                ),
            ]
        }
        NSLayoutConstraint.activate(constraints)

        var buttons: [(KeyboardKeyButton, CGFloat)] = []
        for key in keys {
            let button = KeyboardKeyButton()
            button.key = key
            configure(button, for: key, state: state)
            button.onPress = { [weak self] key in
                guard let self else { return }
                feedback.keyActivated(hapticsEnabled: hapticsEnabled)
                if key != .globe {
                    onKey?(key)
                }
            }
            if case .character = key {
                button.onCharacterPreviewChange = {
                    [weak self, weak button] isVisible in
                    guard let self, let button else { return }
                    if isVisible {
                        presentCharacterPreview(for: button)
                    } else {
                        dismissCharacterPreview(ownedBy: button)
                    }
                }
            }
            if key == .delete {
                button.onDelete = { [weak self] isRepeat in
                    guard let self else { return }
                    if isRepeat {
                        feedback.deleteRepeated()
                    } else {
                        feedback.keyActivated(
                            hapticsEnabled: hapticsEnabled
                        )
                    }
                    onDelete?()
                }
                button.onDeleteEnded = { [weak self] in
                    self?.onDeleteEnded?()
                }
            }
            if key == .space {
                button.onCursorDelta = { [weak self] delta in
                    self?.handleCursorDelta(delta)
                }
            }
            if key == .globe {
                configureInputModeSwitchKey?(button)
            }
            stack.addArrangedSubview(button)
            buttons.append((button, widthWeight(for: key)))
        }
        if let (reference, referenceWeight) = buttons.first {
            for (button, weight) in buttons.dropFirst() {
                button.widthAnchor.constraint(
                    equalTo: reference.widthAnchor,
                    multiplier: weight / referenceWeight
                ).isActive = true
            }
        }
        if rowIndex == 2,
           state.page == .alphabet,
           buttons.count >= 3
        {
            stack.setCustomSpacing(
                metrics.alphabetOuterKeyGap,
                after: buttons[0].0
            )
            stack.setCustomSpacing(
                metrics.alphabetOuterKeyGap,
                after: buttons[buttons.count - 2].0
            )
        }
        return (container, buttons.first?.0)
    }

    func handleCursorDelta(_ delta: Int) {
        guard delta != 0 else { return }
        for _ in 0..<abs(delta) {
            feedback.cursorMoved(hapticsEnabled: hapticsEnabled)
        }
        onCursorDelta?(delta)
    }

    private func presentCharacterPreview(for button: KeyboardKeyButton) {
        guard let character = button.currentTitle, !character.isEmpty else {
            return
        }
        layoutIfNeeded()
        let keyFrame = button.convert(button.bounds, to: self)
        let layout = KeyboardCharacterPreviewGeometry.layout(
            above: keyFrame,
            containerWidth: bounds.width
        )
        characterPreviewOwner = button
        characterPreview.present(character: character, layout: layout)
        bringSubviewToFront(characterPreview)
    }

    private func dismissCharacterPreview(
        ownedBy button: KeyboardKeyButton? = nil
    ) {
        if let button, characterPreviewOwner !== button {
            return
        }
        characterPreviewOwner = nil
        characterPreview.dismiss()
    }

    private func configure(
        _ button: KeyboardKeyButton,
        for key: KeyboardKey,
        state: KeyboardLayoutState
    ) {
        button.appearanceRole = isSpecial(key) ? .special : .regular
        button.setTitleColor(.label, for: .normal)
        button.titleLabel?.font = .systemFont(
            ofSize: titleSize(for: key),
            weight: .regular
        )
        if key == .globe {
            button.setTitle(nil, for: .normal)
            button.setImage(UIImage(systemName: "globe"), for: .normal)
            button.tintColor = .label
        } else if key == .return {
            configureReturnKey(button)
        } else {
            button.setImage(nil, for: .normal)
            button.setTitle(title(for: key, state: state), for: .normal)
        }
        button.accessibilityIdentifier = accessibilityIdentifier(for: key)
        button.accessibilityLabel = accessibilityLabel(for: key)
        button.accessibilityTraits = [.keyboardKey]
        button.accessibilityValue = nil
        button.isActiveSpecial = false
        if key == .shift, state.shift == .locked {
            button.accessibilityValue = "Caps Lock"
            button.isActiveSpecial = true
        } else if key == .shift, state.shift == .on {
            button.accessibilityValue = "On"
            button.isActiveSpecial = true
        }
    }

    private func configureReturnKey(_ button: UIButton) {
        switch returnKeyPresentation.visual {
        case .title(let title):
            button.setImage(nil, for: .normal)
            button.setTitle(title, for: .normal)
        case .systemImage(let name):
            let configuration = UIImage.SymbolConfiguration(
                pointSize: 24,
                weight: .regular
            )
            button.setTitle(nil, for: .normal)
            button.setImage(
                UIImage(
                    systemName: name,
                    withConfiguration: configuration
                ),
                for: .normal
            )
            button.tintColor = .label
        }
    }

    private func title(
        for key: KeyboardKey,
        state: KeyboardLayoutState
    ) -> String {
        switch key {
        case .character(let character):
            state.page == .alphabet && state.shift != .off
                ? character.uppercased()
                : character
        case .shift:
            state.shift == .locked ? "⇪" : "⇧"
        case .delete: "⌫"
        case .page(.alphabet): "ABC"
        case .page(.numbers): "123"
        case .page(.symbols): "#+="
        case .globe: ""
        case .space: ""
        case .return:
            switch returnKeyPresentation.visual {
            case .title(let title): title
            case .systemImage: ""
            }
        }
    }

    private func accessibilityLabel(for key: KeyboardKey) -> String {
        switch key {
        case .character(let character): character
        case .shift: "Shift"
        case .delete: "Delete"
        case .page(.alphabet): "Letters"
        case .page(.numbers): "Numbers"
        case .page(.symbols): "Symbols"
        case .globe: "Next keyboard"
        case .space: "Space"
        case .return: returnKeyPresentation.accessibilityLabel
        }
    }

    private func accessibilityIdentifier(for key: KeyboardKey) -> String {
        let suffix: String
        switch key {
        case .character(let character):
            suffix = character.unicodeScalars
                .map { String($0.value, radix: 16) }
                .joined(separator: "-")
        case .shift: suffix = "shift"
        case .delete: suffix = "delete"
        case .page(.alphabet): suffix = "letters"
        case .page(.numbers): suffix = "numbers"
        case .page(.symbols): suffix = "symbols"
        case .globe: suffix = "globe"
        case .space: suffix = "space"
        case .return: suffix = "return"
        }
        return "agentdesk-key-\(suffix)"
    }

    private func isSpecial(_ key: KeyboardKey) -> Bool {
        switch key {
        case .character, .space:
            false
        default:
            true
        }
    }

    private func widthWeight(for key: KeyboardKey) -> CGFloat {
        switch key {
        case .space: 3.4
        case .return: 1.65
        case .page: 1.35
        case .globe: 1.05
        case .shift, .delete: 1.25
        case .character: 0.88
        }
    }

    private func titleSize(for key: KeyboardKey) -> CGFloat {
        switch key {
        case .return:
            24
        case .page: 18
        case .space: 16
        default: 22
        }
    }
}

@MainActor
final class KeyboardKeyButton: UIButton {
    var key: KeyboardKey? {
        didSet {
            spacePanRecognizer.isEnabled = key == .space
        }
    }
    var appearanceRole: KeyboardKeyRole = .regular {
        didSet { applyVisualState() }
    }
    var isActiveSpecial = false {
        didSet { applyVisualState() }
    }
    var onPress: ((KeyboardKey) -> Void)?
    var onDelete: ((Bool) -> Void)?
    var onDeleteEnded: (() -> Void)?
    var onCursorDelta: ((Int) -> Void)?
    var onCharacterPreviewChange: ((Bool) -> Void)?

    override var isHighlighted: Bool {
        didSet { applyVisualState() }
    }

    private let repeatScheduler: KeyboardRepeatScheduling
    private var didCancelTouch = false
    private var spacePanStart: CGPoint?
    private var spacePanDidMove = false
    private var lastCursorStep = 0
    private lazy var spacePanRecognizer = UIPanGestureRecognizer(
        target: self,
        action: #selector(handlePan(_:))
    )

    init(
        repeatScheduler: KeyboardRepeatScheduling =
            TaskKeyboardRepeatScheduler()
    ) {
        self.repeatScheduler = repeatScheduler
        super.init(frame: .zero)
        addTarget(self, action: #selector(touchDown), for: .touchDown)
        addTarget(
            self,
            action: #selector(touchUpInside),
            for: .touchUpInside
        )
        addTarget(
            self,
            action: #selector(cancelKeyTracking),
            for: [.touchUpOutside, .touchCancel, .touchDragExit]
        )
        spacePanRecognizer.maximumNumberOfTouches = 1
        spacePanRecognizer.isEnabled = false
        addGestureRecognizer(spacePanRecognizer)
        isAccessibilityElement = true
        layer.cornerRadius = KeyboardKeyAppearance.cornerRadius
        layer.shadowColor = UIColor.black.cgColor
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (button: KeyboardKeyButton, _) in
            button.applyVisualState()
        }
        applyVisualState()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.shadowPath = UIBezierPath(
            roundedRect: bounds,
            cornerRadius: KeyboardKeyAppearance.cornerRadius
        ).cgPath
    }

    @objc func touchDown() {
        didCancelTouch = false
        spacePanDidMove = false
        if case .character = key {
            onCharacterPreviewChange?(true)
        }
        guard key == .delete else { return }
        onDelete?(false)
        repeatScheduler.start(
            after: .milliseconds(450),
            every: .milliseconds(80)
        ) { [weak self] in
            guard let self, !didCancelTouch else { return }
            onDelete?(true)
        }
    }

    @objc func touchUpInside() {
        onCharacterPreviewChange?(false)
        stopRepeating()
        if key == .delete {
            onDeleteEnded?()
            return
        }
        guard !didCancelTouch,
              !spacePanDidMove,
              let key
        else {
            return
        }
        onPress?(key)
    }

    @objc func cancelKeyTracking() {
        didCancelTouch = true
        onCharacterPreviewChange?(false)
        stopRepeating()
        if key == .delete {
            onDeleteEnded?()
        }
        isHighlighted = false
    }

    private func stopRepeating() {
        repeatScheduler.stop()
    }

    private func applyVisualState() {
        let values = KeyboardKeyAppearance.tokens(
            for: appearanceRole,
            style: traitCollection.userInterfaceStyle
        )
        if isActiveSpecial {
            backgroundColor = tintColor.withAlphaComponent(
                isHighlighted ? 0.62 : 0.42
            )
        } else {
            backgroundColor = isHighlighted
                ? KeyboardKeyAppearance.pressedFill(for: appearanceRole)
                : KeyboardKeyAppearance.restingFill(for: appearanceRole)
        }
        transform = isHighlighted
            ? CGAffineTransform(translationX: 0, y: 1)
            : .identity
        layer.shadowOpacity = isHighlighted
            ? values.shadowOpacity * 0.35
            : values.shadowOpacity
        layer.shadowOffset = isHighlighted
            ? KeyboardKeyAppearance.pressedShadowOffset
            : KeyboardKeyAppearance.restingShadowOffset
        layer.shadowRadius = isHighlighted
            ? KeyboardKeyAppearance.pressedShadowRadius
            : KeyboardKeyAppearance.restingShadowRadius
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard key == .space else { return }
        switch recognizer.state {
        case .began:
            spacePanStart = recognizer.location(in: self)
            spacePanDidMove = false
            lastCursorStep = 0
        case .changed:
            guard let start = spacePanStart else { return }
            let current = recognizer.location(in: self)
            let step = Int((current.x - start.x) / 14)
            let delta = step - lastCursorStep
            if delta != 0 {
                spacePanDidMove = true
                lastCursorStep = step
                onCursorDelta?(delta)
            }
        default:
            spacePanStart = nil
            lastCursorStep = 0
        }
    }
}
