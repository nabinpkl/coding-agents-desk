import KeyboardDictation
import UIKit

/// Temporary activation and management surface for the deliberately armed
/// keyboard microphone lease. The coordinator remains authoritative after this
/// screen is dismissed.
@MainActor
final class KeyboardDictationHandoffViewController: UIViewController {
    private let coordinator: KeyboardDictationCoordinator
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let detailLabel = UILabel()
    private let meter = UIProgressView(progressViewStyle: .bar)
    private let retryButton = UIButton(type: .system)
    private let useInAgentDeskButton = UIButton(type: .system)
    private let turnOffButton = UIButton(type: .system)
    private var lastAnnouncedPhase: KeyboardDictationServicePhase?
    private var snapshotObservationID: UUID?

    var onRetry: (() -> Void)?
    var onClose: (() -> Void)?
    var onUseInAgentDesk: (() -> Void)?
    var onTurnOff: (() -> Void)?

    init(coordinator: KeyboardDictationCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Keyboard Dictation"
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(closeTapped)
        )

        let icon = UIImageView(image: UIImage(
            systemName: "mic.badge.plus"
        ))
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 52,
            weight: .medium
        )
        icon.tintColor = .systemBlue
        icon.contentMode = .scaleAspectFit
        icon.isAccessibilityElement = false

        titleLabel.font = .preferredFont(forTextStyle: .largeTitle)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 0
        titleLabel.textAlignment = .center

        statusLabel.font = .preferredFont(forTextStyle: .headline)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.accessibilityIdentifier =
            "keyboard-dictation-service-status"

        detailLabel.font = .preferredFont(forTextStyle: .body)
        detailLabel.adjustsFontForContentSizeCategory = true
        detailLabel.textColor = .secondaryLabel
        detailLabel.numberOfLines = 0
        detailLabel.textAlignment = .center

        meter.progressTintColor = .systemBlue
        meter.trackTintColor = .tertiarySystemFill
        meter.isHidden = true
        meter.accessibilityLabel = "Microphone level"

        retryButton.configuration = .filled()
        retryButton.configuration?.cornerStyle = .large
        retryButton.setTitle("Try Again", for: .normal)
        retryButton.addTarget(
            self,
            action: #selector(retryTapped),
            for: .touchUpInside
        )
        retryButton.isHidden = true

        useInAgentDeskButton.configuration = .filled()
        useInAgentDeskButton.configuration?.cornerStyle = .large
        useInAgentDeskButton.setTitle("Use in AgentDesk", for: .normal)
        useInAgentDeskButton.accessibilityIdentifier =
            "keyboard-dictation-use-in-agentdesk"
        useInAgentDeskButton.addTarget(
            self,
            action: #selector(useInAgentDeskTapped),
            for: .touchUpInside
        )
        useInAgentDeskButton.isHidden = true

        turnOffButton.configuration = .bordered()
        turnOffButton.configuration?.cornerStyle = .large
        turnOffButton.configuration?.baseForegroundColor = .systemRed
        turnOffButton.setTitle("Turn Off", for: .normal)
        turnOffButton.addTarget(
            self,
            action: #selector(turnOffTapped),
            for: .touchUpInside
        )

        let stack = UIStackView(arrangedSubviews: [
            icon,
            titleLabel,
            statusLabel,
            detailLabel,
            meter,
            retryButton,
            useInAgentDeskButton,
            turnOffButton,
        ])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 18
        stack.setCustomSpacing(28, after: detailLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(
                equalTo: view.layoutMarginsGuide.leadingAnchor
            ),
            stack.trailingAnchor.constraint(
                equalTo: view.layoutMarginsGuide.trailingAnchor
            ),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            icon.heightAnchor.constraint(equalToConstant: 70),
            retryButton.heightAnchor.constraint(
                greaterThanOrEqualToConstant: 50
            ),
            useInAgentDeskButton.heightAnchor.constraint(
                greaterThanOrEqualToConstant: 50
            ),
            turnOffButton.heightAnchor.constraint(
                greaterThanOrEqualToConstant: 50
            ),
        ])

        render(coordinator.currentSnapshot)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if snapshotObservationID == nil {
            snapshotObservationID = coordinator.observeSnapshots {
                [weak self] snapshot in
                self?.render(snapshot)
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        coordinator.removeSnapshotObserver(snapshotObservationID)
        snapshotObservationID = nil
    }

    private func render(_ snapshot: KeyboardDictationServiceSnapshot) {
        retryButton.isHidden = true
        useInAgentDeskButton.isHidden =
            !KeyboardDictationLifecyclePolicy.canUseInAgentDesk(
                snapshot: snapshot
            )
        meter.isHidden = true
        switch snapshot.phase {
        case .inactive:
            titleLabel.text = "Keyboard Dictation"
            statusLabel.text = "Keyboard dictation is off"
            detailLabel.text =
                "Activate it to use the AgentDesk microphone from the keyboard."
        case .arming:
            titleLabel.text = "Starting AgentDesk"
            statusLabel.text = "Starting microphone and Mac connection…"
            detailLabel.text =
                "Keep AgentDesk open until activation completes."
        case .ready:
            titleLabel.text = "AgentDesk is active"
            statusLabel.text = "Ready for keyboard dictation"
            detailLabel.text =
                "On iOS 26.4 or later, swipe right across the bottom edge to return to the previous app. Then tap the microphone in the AgentDesk keyboard."
        case .recording:
            titleLabel.text = "AgentDesk is active"
            statusLabel.text = snapshot.partialTranscript?.isEmpty == false
                ? snapshot.partialTranscript
                : "Listening…"
            detailLabel.text =
                "Stop from the keyboard when you finish speaking."
            meter.progress = snapshot.meterLevel
            meter.isHidden = false
        case .saving:
            titleLabel.text = "Finishing Dictation"
            statusLabel.text = "Saving recording…"
            detailLabel.text = "The Mac is retaining the accepted audio."
        case .transcribing:
            titleLabel.text = "Finishing Dictation"
            statusLabel.text = "Transcribing on the Mac…"
            detailLabel.text = "Keep AgentDesk active."
        case .analyzing:
            titleLabel.text = "Finishing Dictation"
            statusLabel.text = "Analyzing pronunciation…"
            detailLabel.text = "The recording is already saved on the Mac."
        case .completed:
            titleLabel.text = "AgentDesk is active"
            statusLabel.text = "Dictation complete"
            detailLabel.text = snapshot.finalTranscript
                ?? "The recording completed without a transcript."
        case .failed:
            titleLabel.text = "AgentDesk needs attention"
            statusLabel.text = "Keyboard dictation needs attention"
            detailLabel.text = snapshot.errorMessage
                ?? "Keyboard dictation failed."
            retryButton.isHidden = false
        }
        if snapshot.phase != lastAnnouncedPhase {
            lastAnnouncedPhase = snapshot.phase
            UIAccessibility.post(
                notification: .announcement,
                argument: statusLabel.text
            )
        }
    }

    @objc private func retryTapped() {
        onRetry?()
    }

    @objc private func closeTapped() {
        onClose?()
    }

    @objc private func useInAgentDeskTapped() {
        onUseInAgentDesk?()
    }

    @objc private func turnOffTapped() {
        onTurnOff?()
    }
}
