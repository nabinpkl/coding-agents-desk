import KeyboardDictation
import UIKit

@MainActor
final class AgentDeskQWERTYView: UIView {
    var onKey: ((KeyboardKey) -> Void)?
    var onDeleteBegan: (() -> Void)?
    var onCursorDelta: ((Int) -> Void)?
    var returnKeyTitle = "return" {
        didSet {
            if returnKeyTitle != oldValue {
                renderedState = nil
            }
        }
    }

    private let rowsStack = UIStackView()
    private var renderedState: KeyboardLayoutState?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        rowsStack.axis = .vertical
        rowsStack.distribution = .fillEqually
        rowsStack.spacing = 6
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rowsStack)
        NSLayoutConstraint.activate([
            rowsStack.topAnchor.constraint(equalTo: topAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: leadingAnchor),
            rowsStack.trailingAnchor.constraint(equalTo: trailingAnchor),
            rowsStack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func render(_ state: KeyboardLayoutState) {
        guard renderedState != state else { return }
        renderedState = state
        rowsStack.arrangedSubviews.forEach {
            rowsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for (rowIndex, keys) in state.rows.enumerated() {
            rowsStack.addArrangedSubview(makeRow(
                keys,
                rowIndex: rowIndex,
                state: state
            ))
        }
    }

    private func makeRow(
        _ keys: [KeyboardKey],
        rowIndex: Int,
        state: KeyboardLayoutState
    ) -> UIView {
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fill
        stack.spacing = 5
        let shouldInset = rowIndex == 1 && state.page == .alphabet
        if shouldInset {
            stack.addArrangedSubview(spacer(width: 12))
        }
        var buttons: [(KeyboardKeyButton, CGFloat)] = []
        for key in keys {
            let button = KeyboardKeyButton()
            button.key = key
            configure(button, for: key, state: state)
            button.onPress = { [weak self] key in
                self?.onKey?(key)
            }
            if key == .delete {
                button.onRepeat = { [weak self] in
                    self?.onDeleteBegan?()
                }
            }
            if key == .space {
                button.onCursorDelta = { [weak self] delta in
                    self?.onCursorDelta?(delta)
                }
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
        if shouldInset {
            stack.addArrangedSubview(spacer(width: 12))
        }
        return stack
    }

    private func configure(
        _ button: KeyboardKeyButton,
        for key: KeyboardKey,
        state: KeyboardLayoutState
    ) {
        button.backgroundColor = isSpecial(key)
            ? .tertiarySystemFill
            : .systemBackground
        button.setTitleColor(.label, for: .normal)
        button.layer.cornerRadius = 6
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.16
        button.layer.shadowRadius = 0.5
        button.layer.shadowOffset = CGSize(width: 0, height: 1)
        button.titleLabel?.font = .systemFont(
            ofSize: titleSize(for: key),
            weight: .regular
        )
        if key == .globe {
            button.setTitle(nil, for: .normal)
            button.setImage(UIImage(systemName: "globe"), for: .normal)
            button.tintColor = .label
        } else {
            button.setImage(nil, for: .normal)
            button.setTitle(title(for: key, state: state), for: .normal)
        }
        button.accessibilityLabel = accessibilityLabel(for: key)
        button.accessibilityTraits = [.keyboardKey]
        if key == .shift, state.shift == .locked {
            button.accessibilityValue = "Caps Lock"
            button.backgroundColor = .tintColor
            button.tintColor = .systemBackground
        } else if key == .shift, state.shift == .on {
            button.accessibilityValue = "On"
            button.backgroundColor = .tintColor.withAlphaComponent(0.35)
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
        case .space: "space"
        case .return: returnKeyTitle
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
        case .return: returnKeyTitle
        }
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
        case .page, .return: 14
        case .space: 13
        default: 20
        }
    }

    private func spacer(width: CGFloat) -> UIView {
        let spacer = UIView()
        spacer.widthAnchor.constraint(equalToConstant: width).isActive = true
        return spacer
    }
}

@MainActor
private final class KeyboardKeyButton: UIButton {
    var key: KeyboardKey? {
        didSet {
            spacePanRecognizer.isEnabled = key == .space
        }
    }
    var onPress: ((KeyboardKey) -> Void)?
    var onRepeat: (() -> Void)?
    var onCursorDelta: ((Int) -> Void)?

    private var repeatTask: Task<Void, Never>?
    private var spacePanStart: CGPoint?
    private var lastCursorStep = 0
    private lazy var spacePanRecognizer = UIPanGestureRecognizer(
        target: self,
        action: #selector(handlePan(_:))
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
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
        heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        repeatTask?.cancel()
    }

    @objc private func touchDown() {
        guard key == .delete else { return }
        repeatTask?.cancel()
        repeatTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(450))
                while !Task.isCancelled {
                    self?.onRepeat?()
                    try await Task.sleep(for: .milliseconds(80))
                }
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    @objc private func touchUpInside() {
        stopRepeating()
        guard let key else { return }
        onPress?(key)
    }

    @objc private func cancelKeyTracking() {
        stopRepeating()
    }

    private func stopRepeating() {
        repeatTask?.cancel()
        repeatTask = nil
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard key == .space else { return }
        switch recognizer.state {
        case .began:
            spacePanStart = recognizer.location(in: self)
            lastCursorStep = 0
        case .changed:
            guard let start = spacePanStart else { return }
            let current = recognizer.location(in: self)
            let step = Int((current.x - start.x) / 14)
            let delta = step - lastCursorStep
            if delta != 0 {
                lastCursorStep = step
                onCursorDelta?(delta)
            }
        default:
            spacePanStart = nil
            lastCursorStep = 0
        }
    }
}
