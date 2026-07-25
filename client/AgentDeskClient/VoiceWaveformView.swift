import UIKit

/// Rolling time-domain amplitude envelope for Voice recording and replay.
///
/// Each bar is one normalized RMS sample. This view intentionally does not
/// present a frequency spectrum because the Voice probe supplies amplitude,
/// not FFT bins.
final class VoiceWaveformView: UIView {
    static let sampleCapacity = 48
    static let preferredHeight: CGFloat = 112

    private(set) var levels = Array(
        repeating: Float.zero,
        count: sampleCapacity
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    override var intrinsicContentSize: CGSize {
        CGSize(
            width: UIView.noIntrinsicMetric,
            height: Self.preferredHeight
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func append(level: Float) {
        let clampedLevel = level.isFinite ? min(max(level, 0), 1) : 0
        levels.removeFirst()
        levels.append(clampedLevel)
        accessibilityValue = "\(Int((clampedLevel * 100).rounded())) percent"
        setNeedsDisplay()
    }

    func reset() {
        levels = Array(repeating: 0, count: Self.sampleCapacity)
        accessibilityValue = "0 percent"
        setNeedsDisplay()
    }

    override func tintColorDidChange() {
        super.tintColorDidChange()
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        let plotBounds = bounds.insetBy(dx: 8, dy: 8)
        guard plotBounds.width > 0, plotBounds.height > 0 else { return }

        let centerLine = UIBezierPath()
        centerLine.move(to: CGPoint(x: plotBounds.minX, y: plotBounds.midY))
        centerLine.addLine(to: CGPoint(x: plotBounds.maxX, y: plotBounds.midY))
        UIColor.separator.withAlphaComponent(0.35).setStroke()
        centerLine.lineWidth = 1 / max(traitCollection.displayScale, 1)
        centerLine.stroke()

        let frames = Self.barFrames(levels: levels, in: plotBounds)
        for (index, frame) in frames.enumerated() {
            let recency = CGFloat(index + 1) / CGFloat(frames.count)
            tintColor.withAlphaComponent(0.25 + (recency * 0.75)).setFill()
            UIBezierPath(
                roundedRect: frame,
                cornerRadius: min(frame.width / 2, 2)
            )
            .fill()
        }
    }

    static func barFrames(
        levels: [Float],
        in bounds: CGRect
    ) -> [CGRect] {
        guard !levels.isEmpty, bounds.width > 0, bounds.height > 0 else {
            return []
        }

        let count = CGFloat(levels.count)
        let gap = min(2, max(0, (bounds.width / count) * 0.35))
        let barWidth = max(0, (bounds.width - (gap * (count - 1))) / count)
        let minimumHeight = min(2, bounds.height)
        let availableHeight = max(bounds.height - minimumHeight, 0)

        return levels.enumerated().map { index, level in
            let clampedLevel = CGFloat(level.isFinite ? min(max(level, 0), 1) : 0)
            let height = minimumHeight + (availableHeight * clampedLevel)
            return CGRect(
                x: bounds.minX + (CGFloat(index) * (barWidth + gap)),
                y: bounds.midY - (height / 2),
                width: barWidth,
                height: height
            )
        }
    }

    private func configure() {
        isOpaque = false
        backgroundColor = .tertiarySystemFill
        layer.cornerRadius = 8
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityLabel = "Audio waveform"
        accessibilityHint = "Shows recent audio amplitude over time."
        accessibilityValue = "0 percent"
        accessibilityTraits.insert(.updatesFrequently)
    }
}
