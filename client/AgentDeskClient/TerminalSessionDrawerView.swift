import PtyClientSwift
import UIKit

@available(iOS 26.0, *)
@MainActor
protocol TerminalSessionDrawerViewDelegate: AnyObject {
    func terminalSessionDrawerViewRequestedDismiss(_ drawerView: TerminalSessionDrawerView)
    func terminalSessionDrawerView(_ drawerView: TerminalSessionDrawerView, requestedJoin session: PtySessionSummary)
    func terminalSessionDrawerView(_ drawerView: TerminalSessionDrawerView, requestedCloseSession session: PtySessionSummary)
    func terminalSessionDrawerView(
        _ drawerView: TerminalSessionDrawerView,
        requestedCloseClient client: PtySessionClientSummary,
        in sessionName: String
    )
}

@available(iOS 26.0, *)
@MainActor
final class TerminalSessionDrawerView: UIView {
    weak var delegate: TerminalSessionDrawerViewDelegate?

    private let backdropButton = UIButton(type: .custom)
    private let drawer = UIView()
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let scrollView = UIScrollView()
    private let stackView = UIStackView()
    private var tree = PtySessionTree(sessions: [])
    private var expandedSessionNames = Set<String>()
    private var statusText: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        configureView()
        renderRows()
        setVisible(false, animated: false)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    func setSessions(_ sessions: [PtySessionSummary], status: String? = nil) {
        let sortedSessions = sessions.sorted { left, right in
            left.name.localizedStandardCompare(right.name) == .orderedAscending
        }
        tree = PtySessionTree(sessions: sortedSessions)
        statusText = status
        expandedSessionNames.formIntersection(Set(sortedSessions.map(\.name)))
        renderRows()
    }

    func setStatus(_ status: String?) {
        statusText = status
        renderRows()
    }

    func setVisible(_ visible: Bool, animated: Bool = true) {
        if visible {
            isHidden = false
            isUserInteractionEnabled = true
        }

        let changes = {
            self.alpha = visible ? 1 : 0
            self.drawer.transform = visible ? .identity : CGAffineTransform(translationX: 36, y: 0)
        }
        let completion: (Bool) -> Void = { _ in
            if !visible {
                self.isHidden = true
                self.isUserInteractionEnabled = false
            }
        }

        if animated {
            UIView.animate(
                withDuration: 0.18,
                delay: 0,
                options: [.curveEaseOut, .beginFromCurrentState],
                animations: changes,
                completion: completion
            )
        } else {
            changes()
            completion(true)
        }
    }

    private func configureView() {
        backgroundColor = .clear

        backdropButton.translatesAutoresizingMaskIntoConstraints = false
        backdropButton.backgroundColor = UIColor.black.withAlphaComponent(0.42)
        backdropButton.addTarget(self, action: #selector(handleBackdropTap), for: .touchUpInside)
        addSubview(backdropButton)

        drawer.translatesAutoresizingMaskIntoConstraints = false
        drawer.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.98)
        drawer.layer.cornerRadius = 8
        drawer.layer.borderWidth = 1
        drawer.layer.borderColor = UIColor.separator.cgColor
        drawer.layer.shadowColor = UIColor.black.cgColor
        drawer.layer.shadowOpacity = 0.28
        drawer.layer.shadowRadius = 16
        drawer.layer.shadowOffset = CGSize(width: 0, height: 8)
        addSubview(drawer)

        let header = UIStackView()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = 10
        drawer.addSubview(header)

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.textColor = .label
        titleLabel.text = "PTY Sessions"
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        header.addArrangedSubview(titleLabel)

        let closeButton = makeIconButton(systemName: "xmark", accessibilityLabel: "Close sessions drawer")
        closeButton.addTarget(self, action: #selector(handleCloseTap), for: .touchUpInside)
        header.addArrangedSubview(closeButton)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 3
        drawer.addSubview(statusLabel)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        drawer.addSubview(scrollView)

        stackView.translatesAutoresizingMaskIntoConstraints = false
        stackView.axis = .vertical
        stackView.spacing = 10
        scrollView.addSubview(stackView)

        NSLayoutConstraint.activate([
            backdropButton.leadingAnchor.constraint(equalTo: leadingAnchor),
            backdropButton.trailingAnchor.constraint(equalTo: trailingAnchor),
            backdropButton.topAnchor.constraint(equalTo: topAnchor),
            backdropButton.bottomAnchor.constraint(equalTo: bottomAnchor),

            drawer.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 12),
            drawer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            drawer.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -12),
            drawer.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 10),
            drawer.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            drawer.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.94),

            header.leadingAnchor.constraint(equalTo: drawer.leadingAnchor, constant: 14),
            header.trailingAnchor.constraint(equalTo: drawer.trailingAnchor, constant: -12),
            header.topAnchor.constraint(equalTo: drawer.topAnchor, constant: 12),
            header.heightAnchor.constraint(greaterThanOrEqualToConstant: 34),

            statusLabel.leadingAnchor.constraint(equalTo: drawer.leadingAnchor, constant: 14),
            statusLabel.trailingAnchor.constraint(equalTo: drawer.trailingAnchor, constant: -14),
            statusLabel.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 6),

            scrollView.leadingAnchor.constraint(equalTo: drawer.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: drawer.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 10),
            scrollView.bottomAnchor.constraint(equalTo: drawer.bottomAnchor, constant: -12),

            stackView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 12),
            stackView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -12),
            stackView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stackView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stackView.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -24)
        ])
    }

    private func renderRows() {
        statusLabel.text = statusText
        statusLabel.isHidden = statusText?.isEmpty ?? true

        stackView.arrangedSubviews.forEach { view in
            stackView.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        guard tree.numberOfChildren(of: nil) > 0 else {
            stackView.addArrangedSubview(makeEmptyStateLabel())
            return
        }

        for index in 0..<tree.numberOfChildren(of: nil) {
            guard case .session(let session) = tree.child(index, of: nil) else { continue }
            stackView.addArrangedSubview(makeSessionCard(session))
        }
    }

    private func makeSessionCard(_ session: PtySessionSummary) -> UIView {
        let card = UIView()
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 8
        card.layer.borderWidth = 1
        card.layer.borderColor = UIColor.separator.cgColor

        let content = UIStackView()
        content.translatesAutoresizingMaskIntoConstraints = false
        content.axis = .vertical
        content.spacing = 10
        card.addSubview(content)

        let header = UIStackView()
        header.axis = .horizontal
        header.alignment = .center
        header.spacing = 8
        content.addArrangedSubview(header)

        let expandButton = makeIconButton(
            systemName: expandedSessionNames.contains(session.name) ? "chevron.down" : "chevron.right",
            accessibilityLabel: "Toggle clients for \(session.name)"
        )
        expandButton.isEnabled = !session.clients.isEmpty
        expandButton.alpha = session.clients.isEmpty ? 0.3 : 1
        expandButton.addAction(UIAction { [weak self] _ in
            self?.toggleExpanded(session.name)
        }, for: .touchUpInside)
        header.addArrangedSubview(expandButton)

        let labels = UIStackView()
        labels.axis = .vertical
        labels.spacing = 3
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        header.addArrangedSubview(labels)

        let nameLabel = UILabel()
        nameLabel.font = .monospacedSystemFont(ofSize: 14, weight: .semibold)
        nameLabel.textColor = .label
        nameLabel.lineBreakMode = .byTruncatingMiddle
        nameLabel.text = session.name
        labels.addArrangedSubview(nameLabel)

        let detailLabel = UILabel()
        detailLabel.font = .preferredFont(forTextStyle: .caption1)
        detailLabel.textColor = .secondaryLabel
        detailLabel.numberOfLines = 2
        detailLabel.text = sessionDetailText(session)
        labels.addArrangedSubview(detailLabel)

        let joinButton = makeActionButton(title: "Open", systemName: "plus")
        joinButton.isEnabled = session.state == .running
        joinButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.delegate?.terminalSessionDrawerView(self, requestedJoin: session)
        }, for: .touchUpInside)
        header.addArrangedSubview(joinButton)

        let closeButton = makeIconButton(systemName: "trash", accessibilityLabel: "Close \(session.name)")
        closeButton.tintColor = .systemRed
        closeButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.delegate?.terminalSessionDrawerView(self, requestedCloseSession: session)
        }, for: .touchUpInside)
        header.addArrangedSubview(closeButton)

        if expandedSessionNames.contains(session.name) {
            for clientIndex in 0..<tree.numberOfChildren(of: .session(session)) {
                guard case .client(let sessionName, let client) = tree.child(clientIndex, of: .session(session)) else {
                    continue
                }
                content.addArrangedSubview(makeClientRow(client, sessionName: sessionName))
            }
        }

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 10),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),
            content.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10)
        ])
        return card
    }

    private func makeClientRow(_ client: PtySessionClientSummary, sessionName: String) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 8
        row.layoutMargins = UIEdgeInsets(top: 4, left: 34, bottom: 4, right: 0)
        row.isLayoutMarginsRelativeArrangement = true

        let label = UILabel()
        label.font = .preferredFont(forTextStyle: .caption1)
        label.textColor = .secondaryLabel
        label.numberOfLines = 2
        label.text = client.title.isEmpty ? "Client \(client.id)" : "\(client.title) #\(client.id)"
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        row.addArrangedSubview(label)

        let closeButton = makeIconButton(systemName: "xmark.circle", accessibilityLabel: "Close client \(client.id)")
        closeButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.delegate?.terminalSessionDrawerView(self, requestedCloseClient: client, in: sessionName)
        }, for: .touchUpInside)
        row.addArrangedSubview(closeButton)
        return row
    }

    private func makeEmptyStateLabel() -> UILabel {
        let label = UILabel()
        label.font = .preferredFont(forTextStyle: .callout)
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.textAlignment = .center
        label.text = "No PTY sessions are currently registered."
        return label
    }

    private func sessionDetailText(_ session: PtySessionSummary) -> String {
        let state: String
        switch session.state {
        case .running:
            state = "running"
        case .exited:
            state = "exited"
        case .unspecified:
            state = "unknown"
        }

        let shell = session.shell.isEmpty ? "default shell" : session.shell
        let cwd = session.cwd.isEmpty ? "home" : session.cwd
        return "pid \(session.pid) | \(state) | \(session.clientCount) clients\n\(shell) in \(cwd)"
    }

    private func makeActionButton(title: String, systemName: String) -> UIButton {
        var configuration = UIButton.Configuration.bordered()
        configuration.image = UIImage(systemName: systemName)
        configuration.imagePadding = 4
        configuration.title = title
        configuration.cornerStyle = .small
        let button = UIButton(configuration: configuration)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        return button
    }

    private func makeIconButton(systemName: String, accessibilityLabel: String) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: systemName)
        configuration.cornerStyle = .small
        let button = UIButton(configuration: configuration)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.accessibilityLabel = accessibilityLabel
        button.widthAnchor.constraint(equalToConstant: 36).isActive = true
        button.heightAnchor.constraint(equalToConstant: 34).isActive = true
        return button
    }

    private func toggleExpanded(_ sessionName: String) {
        if expandedSessionNames.contains(sessionName) {
            expandedSessionNames.remove(sessionName)
        } else {
            expandedSessionNames.insert(sessionName)
        }
        renderRows()
    }

    @objc private func handleBackdropTap() {
        delegate?.terminalSessionDrawerViewRequestedDismiss(self)
    }

    @objc private func handleCloseTap() {
        delegate?.terminalSessionDrawerViewRequestedDismiss(self)
    }
}
