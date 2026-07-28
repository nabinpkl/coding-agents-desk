import KeyboardDictation
import UIKit

/// The containing-app half of the keyboard handoff spike. It intentionally
/// confirms only the public URL/App Group return path, leaving audio lifecycle
/// validation to a later physical-device experiment.
@MainActor
final class KeyboardDictationHandoffViewController: UIViewController {
    private let receipt: KeyboardHandoffReceipt

    init(receipt: KeyboardHandoffReceipt) {
        self.receipt = receipt
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Keyboard handoff"
        view.backgroundColor = .systemBackground

        let titleLabel = UILabel()
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.text = "AgentDesk received the keyboard handoff"
        titleLabel.numberOfLines = 0
        titleLabel.textAlignment = .center

        let detailLabel = UILabel()
        detailLabel.font = .preferredFont(forTextStyle: .body)
        detailLabel.textColor = .secondaryLabel
        detailLabel.text = "Swipe back to the text app. The AgentDesk keyboard will confirm the App Group return path there."
        detailLabel.numberOfLines = 0
        detailLabel.textAlignment = .center

        let nonceLabel = UILabel()
        nonceLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        nonceLabel.textColor = .tertiaryLabel
        nonceLabel.text = "Probe \(receipt.nonce.uuidString.prefix(8))"
        nonceLabel.textAlignment = .center

        let stack = UIStackView(arrangedSubviews: [titleLabel, detailLabel, nonceLabel])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }
}
