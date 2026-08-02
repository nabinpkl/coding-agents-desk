import UIKit

struct KeyboardCharacterPreviewLayout: Equatable {
    let frame: CGRect
    let tipX: CGFloat
}

enum KeyboardCharacterPreviewGeometry {
    static let horizontalMargin: CGFloat = 3
    static let minimumWidth: CGFloat = 60
    static let maximumWidth: CGFloat = 72
    static let bubbleHeight: CGFloat = 58
    static let tailHeight: CGFloat = 9
    static let keyOverlap: CGFloat = 3
    static let tailHalfWidth: CGFloat = 8
    static let cornerRadius: CGFloat = 11

    static func layout(
        above keyFrame: CGRect,
        containerWidth: CGFloat
    ) -> KeyboardCharacterPreviewLayout {
        let availableWidth = max(
            0,
            containerWidth - horizontalMargin * 2
        )
        let preferredWidth = min(
            maximumWidth,
            max(minimumWidth, keyFrame.width + 16)
        )
        let width = min(preferredWidth, availableWidth)
        let height = bubbleHeight + tailHeight
        let centeredX = keyFrame.midX - width / 2
        let maximumX = max(
            horizontalMargin,
            containerWidth - horizontalMargin - width
        )
        let x = min(max(centeredX, horizontalMargin), maximumX)
        let minimumTipX = cornerRadius + tailHalfWidth
        let maximumTipX = max(
            minimumTipX,
            width - cornerRadius - tailHalfWidth
        )
        let tipX = min(
            max(keyFrame.midX - x, minimumTipX),
            maximumTipX
        )
        return KeyboardCharacterPreviewLayout(
            frame: CGRect(
                x: x,
                y: keyFrame.minY - height + keyOverlap,
                width: width,
                height: height
            ),
            tipX: tipX
        )
    }
}

@MainActor
final class KeyboardCharacterPreviewView: UIView {
    private let shapeLayer = CAShapeLayer()
    private let characterLabel = UILabel()
    private var tipX = KeyboardCharacterPreviewGeometry.minimumWidth / 2

    var character: String? {
        characterLabel.text
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isHidden = true
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        accessibilityIdentifier = "agentdesk-key-character-preview"

        layer.addSublayer(shapeLayer)
        shapeLayer.shadowColor = UIColor.black.cgColor
        shapeLayer.shadowOffset = CGSize(width: 0, height: 2)
        shapeLayer.shadowRadius = 2

        characterLabel.font = .systemFont(ofSize: 34, weight: .regular)
        characterLabel.textAlignment = .center
        characterLabel.textColor = .label
        addSubview(characterLabel)

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (preview: KeyboardCharacterPreviewView, _) in
            preview.applyAppearance()
        }
        applyAppearance()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func present(
        character: String,
        layout: KeyboardCharacterPreviewLayout
    ) {
        characterLabel.text = character
        frame = layout.frame
        tipX = layout.tipX
        isHidden = false
        setNeedsLayout()
        layoutIfNeeded()
    }

    func dismiss() {
        isHidden = true
        characterLabel.text = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shapeLayer.frame = bounds
        shapeLayer.path = makePath().cgPath
        shapeLayer.shadowPath = shapeLayer.path
        CATransaction.commit()
        characterLabel.frame = CGRect(
            x: 0,
            y: 2,
            width: bounds.width,
            height: KeyboardCharacterPreviewGeometry.bubbleHeight - 4
        )
    }

    private func applyAppearance() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shapeLayer.fillColor =
            KeyboardKeyAppearance.characterPreviewFill.resolvedColor(
                with: traitCollection
            ).cgColor
        shapeLayer.shadowOpacity =
            traitCollection.userInterfaceStyle == .dark ? 0.72 : 0.30
        CATransaction.commit()
    }

    private func makePath() -> UIBezierPath {
        let bubbleHeight = KeyboardCharacterPreviewGeometry.bubbleHeight
        let tailHalfWidth = KeyboardCharacterPreviewGeometry.tailHalfWidth
        let radius = min(
            KeyboardCharacterPreviewGeometry.cornerRadius,
            min(bounds.width, bubbleHeight) / 2
        )
        let path = UIBezierPath()
        path.move(to: CGPoint(x: radius, y: 0))
        path.addLine(to: CGPoint(x: bounds.width - radius, y: 0))
        path.addQuadCurve(
            to: CGPoint(x: bounds.width, y: radius),
            controlPoint: CGPoint(x: bounds.width, y: 0)
        )
        path.addLine(to: CGPoint(x: bounds.width, y: bubbleHeight - radius))
        path.addQuadCurve(
            to: CGPoint(x: bounds.width - radius, y: bubbleHeight),
            controlPoint: CGPoint(x: bounds.width, y: bubbleHeight)
        )
        path.addLine(to: CGPoint(
            x: tipX + tailHalfWidth,
            y: bubbleHeight
        ))
        path.addLine(to: CGPoint(x: tipX, y: bounds.height))
        path.addLine(to: CGPoint(
            x: tipX - tailHalfWidth,
            y: bubbleHeight
        ))
        path.addLine(to: CGPoint(x: radius, y: bubbleHeight))
        path.addQuadCurve(
            to: CGPoint(x: 0, y: bubbleHeight - radius),
            controlPoint: CGPoint(x: 0, y: bubbleHeight)
        )
        path.addLine(to: CGPoint(x: 0, y: radius))
        path.addQuadCurve(
            to: CGPoint(x: radius, y: 0),
            controlPoint: .zero
        )
        path.close()
        return path
    }
}
