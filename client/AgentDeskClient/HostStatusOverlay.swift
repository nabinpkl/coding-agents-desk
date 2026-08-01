import UIKit

/// The host-status overlay: a spinner, a message, and the manual reconnect escape hatch,
/// stacked and centered as one unit.
///
/// It is one view rather than two loose subviews because its placement is load-bearing. The
/// message used to be centered on the video scroll view, which is fine while that view has a
/// sane frame and wrong the moment it does not: across a handover the scroll collapsed and the
/// message rode it to the top of the screen, landing under the notch on a black background
/// (R230). Centering the overlay on the controller's own safe area instead makes the message
/// independent of whatever the video is doing, which is exactly when the user needs to read it.
final class HostStatusOverlay: UIView {
    private let stack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let messageLabel = UILabel()
    let reconnectButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = UIColor.black.withAlphaComponent(0.72)
        layer.cornerRadius = 14
        layer.masksToBounds = true
        isHidden = true

        spinner.color = .white
        spinner.hidesWhenStopped = true

        messageLabel.textColor = .white
        messageLabel.font = .preferredFont(forTextStyle: .headline)
        messageLabel.numberOfLines = 0
        messageLabel.textAlignment = .center

        reconnectButton.setTitle("Reconnect", for: .normal)
        reconnectButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        reconnectButton.setTitleColor(.white, for: .normal)
        reconnectButton.backgroundColor = UIColor.white.withAlphaComponent(0.18)
        reconnectButton.contentEdgeInsets = UIEdgeInsets(top: 10, left: 22, bottom: 10, right: 22)
        reconnectButton.layer.cornerRadius = 10
        reconnectButton.layer.masksToBounds = true

        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(spinner)
        stack.addArrangedSubview(messageLabel)
        stack.addArrangedSubview(reconnectButton)
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("HostStatusOverlay is code-only")
    }

    func apply(_ presentation: HostStatusPresentation) {
        guard let message = presentation.message else {
            isHidden = true
            spinner.stopAnimating()
            return
        }
        messageLabel.text = message
        // A stack view still reserves space for a hidden arranged subview's spacing in some
        // configurations, so drive membership through isHidden and let the stack collapse it.
        spinner.isHidden = !presentation.showsActivity
        if presentation.showsActivity {
            spinner.startAnimating()
        } else {
            spinner.stopAnimating()
        }
        reconnectButton.isHidden = !presentation.offersReconnect
        isHidden = false
        superview?.bringSubviewToFront(self)
    }
}
