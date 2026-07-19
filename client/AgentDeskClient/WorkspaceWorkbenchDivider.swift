import UIKit

@MainActor
final class WorkspaceWorkbenchDivider: UIControl {
    enum Axis { case horizontal, vertical }

    var onPan: ((CGFloat) -> Void)?
    var onIncrement: (() -> Void)?
    var onDecrement: (() -> Void)?

    private let axis: Axis
    private let line = UIView()

    init(axis: Axis, accessibilityLabel: String) {
        self.axis = axis
        super.init(frame: .zero)
        self.accessibilityLabel = accessibilityLabel
        isAccessibilityElement = true
        accessibilityTraits = [.adjustable]
        accessibilityIdentifier = axis == .vertical
            ? "workspace-sidebar-divider"
            : "workspace-terminal-divider"
        setUp()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func accessibilityIncrement() { onIncrement?() }
    override func accessibilityDecrement() { onDecrement?() }

    private func setUp() {
        backgroundColor = .systemBackground
        line.translatesAutoresizingMaskIntoConstraints = false
        line.backgroundColor = .separator
        addSubview(line)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        addGestureRecognizer(pan)
        switch axis {
        case .vertical:
            NSLayoutConstraint.activate([
                line.centerXAnchor.constraint(equalTo: centerXAnchor),
                line.topAnchor.constraint(equalTo: topAnchor),
                line.bottomAnchor.constraint(equalTo: bottomAnchor),
                line.widthAnchor.constraint(equalToConstant: 1),
            ])
        case .horizontal:
            NSLayoutConstraint.activate([
                line.centerYAnchor.constraint(equalTo: centerYAnchor),
                line.leadingAnchor.constraint(equalTo: leadingAnchor),
                line.trailingAnchor.constraint(equalTo: trailingAnchor),
                line.heightAnchor.constraint(equalToConstant: 1),
            ])
        }
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        let translation = recognizer.translation(in: self)
        onPan?(axis == .vertical ? translation.x : translation.y)
        recognizer.setTranslation(.zero, in: self)
    }
}
