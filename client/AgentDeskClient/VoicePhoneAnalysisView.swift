import UIKit

final class VoicePhoneAnalysisView: UIView {
    private let stack = UIStackView()

    init(presentation: VoicePhoneAnalysisPresentation) {
        super.init(frame: .zero)
        configure()
        render(presentation)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    private func configure() {
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    private func render(_ presentation: VoicePhoneAnalysisPresentation) {
        switch presentation {
        case .message(let message):
            stack.addArrangedSubview(messageCard(message))
        case .evidence(let evidence):
            stack.addArrangedSubview(evidenceHeader(evidence))
            for (index, phone) in evidence.phones.enumerated() {
                stack.addArrangedSubview(phoneCard(phone, index: index))
            }
            stack.addArrangedSubview(technicalDetailsCard(evidence.technicalDetails))
        }
    }

    private func evidenceHeader(_ evidence: VoicePhoneAnalysisEvidence) -> UIView {
        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 5
        content.addArrangedSubview(label(
            "RAW ACOUSTIC EVIDENCE",
            style: .caption1,
            color: .secondaryLabel,
            weight: .semibold
        ))
        content.addArrangedSubview(label(
            evidence.targetWord,
            style: .title2,
            weight: .bold
        ))
        content.addArrangedSubview(label(
            "Raw model output and calibrated assessment are shown separately.",
            style: .footnote,
            color: .secondaryLabel
        ))
        content.addArrangedSubview(label(
            "Expected phone sequence",
            style: .caption1,
            color: .secondaryLabel
        ))
        let sequence = label(
            "/ \(evidence.targetSequence) /",
            style: .title3,
            weight: .semibold
        )
        sequence.accessibilityIdentifier = "voice-phone-target-sequence"
        content.addArrangedSubview(sequence)
        return card(content, backgroundColor: .secondarySystemBackground, radius: 10)
    }

    private func phoneCard(
        _ phone: VoicePhoneAnalysisPhone,
        index: Int
    ) -> UIView {
        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 10

        let comparison = VoicePhoneAdaptiveStack()
        comparison.alignment = .top
        comparison.distribution = .fillEqually
        comparison.spacing = 12
        comparison.addArrangedSubview(phoneValue(
            caption: "EXPECTED",
            value: phone.expectedPhone
        ))
        comparison.addArrangedSubview(phoneValue(
            caption: "MODEL HEARD",
            value: phone.observedPhone
        ))
        content.addArrangedSubview(comparison)

        let range = label(
            phone.timeRange,
            style: .caption1,
            color: .secondaryLabel,
            weight: .medium
        )
        applyMonospacedStyle(to: range, style: .caption1, weight: .medium)
        content.addArrangedSubview(range)

        content.addArrangedSubview(statusPanel(
            title: phone.assessmentTitle,
            detail: phone.assessmentDetail,
            tone: phone.assessmentTone
        ))

        let evidenceGrid = UIStackView()
        evidenceGrid.axis = .vertical
        evidenceGrid.spacing = 6
        for detail in phone.evidence {
            evidenceGrid.addArrangedSubview(detailRow(detail))
        }
        content.addArrangedSubview(evidenceGrid)

        content.addArrangedSubview(label(
            "Strongest competing phones",
            style: .caption1,
            color: .secondaryLabel,
            weight: .semibold
        ))
        let competitors = label(phone.competitors, style: .footnote)
        applyMonospacedStyle(to: competitors, style: .footnote)
        content.addArrangedSubview(competitors)

        if let calibration = phone.calibration {
            content.addArrangedSubview(label(
                "Calibration · \(calibration)",
                style: .caption2,
                color: .secondaryLabel
            ))
        }

        let result = card(content, backgroundColor: .secondarySystemBackground, radius: 10)
        result.accessibilityIdentifier = "voice-phone-row-\(index)"
        result.isAccessibilityElement = true
        result.accessibilityLabel = phone.accessibilitySummary
        return result
    }

    private func messageCard(_ message: VoicePhoneAnalysisMessage) -> UIView {
        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 6
        let title = label(message.title, style: .headline, weight: .semibold)
        title.accessibilityTraits.insert(.header)
        content.addArrangedSubview(title)
        content.addArrangedSubview(label(
            message.detail,
            style: .footnote,
            color: .secondaryLabel
        ))
        let result = card(
            content,
            backgroundColor: backgroundColor(for: message.tone),
            radius: 10
        )
        result.accessibilityIdentifier = "voice-phone-analysis-message"
        return result
    }

    private func statusPanel(
        title: String,
        detail: String,
        tone: VoicePhoneAnalysisMessageTone
    ) -> UIView {
        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 3
        content.addArrangedSubview(label(title, style: .subheadline, weight: .semibold))
        content.addArrangedSubview(label(
            detail,
            style: .footnote,
            color: .secondaryLabel
        ))
        return card(content, backgroundColor: backgroundColor(for: tone), radius: 8)
    }

    private func technicalDetailsCard(
        _ details: [VoicePhoneAnalysisDetail]
    ) -> UIView {
        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 7
        let heading = label("Technical details", style: .headline, weight: .semibold)
        heading.accessibilityTraits.insert(.header)
        content.addArrangedSubview(heading)
        for detail in details {
            content.addArrangedSubview(detailRow(detail))
        }
        let result = card(content, backgroundColor: .secondarySystemBackground, radius: 10)
        result.accessibilityIdentifier = "voice-phone-technical-details"
        result.isAccessibilityElement = true
        result.accessibilityLabel = details
            .map { "\($0.label), \($0.value)" }
            .joined(separator: ". ")
        return result
    }

    private func phoneValue(caption: String, value: String) -> UIView {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 2
        stack.addArrangedSubview(label(
            caption,
            style: .caption2,
            color: .secondaryLabel,
            weight: .semibold
        ))
        stack.addArrangedSubview(label(value, style: .title1, weight: .bold))
        return stack
    }

    private func detailRow(_ detail: VoicePhoneAnalysisDetail) -> UIView {
        let row = UIStackView()
        row.axis = .vertical
        row.alignment = .fill
        row.spacing = 2
        let key = label(detail.label, style: .caption1, color: .secondaryLabel)
        let value = label(detail.value, style: .caption1, weight: .medium)
        applyMonospacedStyle(to: value, style: .caption1, weight: .medium)
        row.addArrangedSubview(key)
        row.addArrangedSubview(value)
        return row
    }

    private func card(
        _ content: UIView,
        backgroundColor: UIColor,
        radius: CGFloat
    ) -> UIView {
        let container = VoicePhoneBorderedCard()
        container.backgroundColor = backgroundColor
        container.layer.cornerRadius = radius
        content.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12)
        ])
        return container
    }

    private func label(
        _ text: String,
        style: UIFont.TextStyle,
        color: UIColor = .label,
        weight: UIFont.Weight = .regular
    ) -> UILabel {
        let label = UILabel()
        let descriptor = UIFontDescriptor.preferredFontDescriptor(withTextStyle: style)
        label.font = UIFont(descriptor: descriptor, size: 0)
            .withWeight(weight)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = 0
        label.text = text
        return label
    }

    private func applyMonospacedStyle(
        to label: UILabel,
        style: UIFont.TextStyle,
        weight: UIFont.Weight = .regular
    ) {
        let preferred = UIFontDescriptor.preferredFontDescriptor(withTextStyle: style)
        let monospaced = preferred.withDesign(.monospaced) ?? preferred
        label.font = UIFont(descriptor: monospaced, size: 0).withWeight(weight)
    }

    private func backgroundColor(
        for tone: VoicePhoneAnalysisMessageTone
    ) -> UIColor {
        switch tone {
        case .neutral:
            .tertiarySystemBackground
        case .warning:
            .systemOrange.withAlphaComponent(0.12)
        case .error:
            .systemRed.withAlphaComponent(0.12)
        }
    }
}

private final class VoicePhoneAdaptiveStack: UIStackView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        updateAxis()
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
            (stack: VoicePhoneAdaptiveStack, _) in
            stack.updateAxis()
        }
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    private func updateAxis() {
        axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory
            ? .vertical
            : .horizontal
    }
}

private final class VoicePhoneBorderedCard: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.borderWidth = 0.5
        updateBorderColor()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (view: VoicePhoneBorderedCard, _) in
            view.updateBorderColor()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    private func updateBorderColor() {
        layer.borderColor = UIColor.separator
            .resolvedColor(with: traitCollection)
            .cgColor
    }
}

private extension UIFont {
    func withWeight(_ weight: UIFont.Weight) -> UIFont {
        let traits = [UIFontDescriptor.TraitKey.weight: weight]
        let descriptor = fontDescriptor.addingAttributes([
            UIFontDescriptor.AttributeName.traits: traits
        ])
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
