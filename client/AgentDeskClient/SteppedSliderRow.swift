import UIKit

/// Tick marks and captions under a slider, placed along the thumb's travel.
///
/// Positions are measured against the THUMB rather than the view's width, because a slider's
/// thumb centre never reaches either edge. Marks placed by width sit a half-thumb away from
/// the value they claim to label, and the error is worst at the two ends, which are exactly
/// the marks a reader trusts most ("this is the minimum").
final class SliderMarkerStrip: UIView {
    struct Marker {
        /// 0 at the leftmost thumb centre, 1 at the rightmost.
        let position: CGFloat
        /// nil draws the tick with no caption. Dense axes need every stop marked so the thumb
        /// visibly lands on something, but naming all of them would overlap into mush.
        let title: String?
    }

    var markers: [Marker] = [] {
        didSet { rebuildCaptions() }
    }

    /// The slider these marks line up with. Weak because it is a sibling owned by the same
    /// row; the strip only measures it. Measuring beats being told: the owner would have to
    /// re-tell the strip on every bounds change, and forgetting once leaves marks that point
    /// at the wrong values with nothing to show for it.
    weak var slider: UISlider? {
        didSet { setNeedsLayout() }
    }

    /// Captions paired with the marker they belong to, so an unnamed tick simply has no entry.
    private var captions: [(index: Int, label: UILabel)] = []
    private let tickHeight: CGFloat = 4
    private let namedTickHeight: CGFloat = 6
    private let tickGap: CGFloat = 3
    private var travel: ClosedRange<CGFloat> = 0...0

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        backgroundColor = .clear
        // Ticks are drawn in draw(_:), so the view has to be told to redraw when it resizes;
        // the default scaleToFill would stretch the old ticks instead.
        contentMode = .redraw
        isUserInteractionEnabled = false
        // The slider above carries the accessible value. These marks repeat it visually and
        // would only add noise to VoiceOver.
        isAccessibilityElement = false
    }

    override var intrinsicContentSize: CGSize {
        let captionHeight = captions.first?.label.intrinsicContentSize.height ?? 12
        return CGSize(
            width: UIView.noIntrinsicMetric,
            height: namedTickHeight + tickGap + captionHeight
        )
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateTravel()
        for caption in captions {
            guard markers.indices.contains(caption.index) else { continue }
            let size = caption.label.intrinsicContentSize
            var frame = CGRect(
                x: x(for: markers[caption.index].position) - size.width / 2,
                y: namedTickHeight + tickGap,
                width: size.width,
                height: size.height
            )
            // Hold the end captions inside the row. The first and last marks sit at the ends of
            // the thumb's travel, so a centred caption there hangs off the edge and clips.
            frame.origin.x = min(max(frame.origin.x, 0), max(bounds.width - size.width, 0))
            caption.label.frame = frame
        }
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), !markers.isEmpty else { return }
        context.setLineWidth(1)
        for marker in markers {
            let centre = x(for: marker.position).rounded() + 0.5
            // A named stop gets a longer, darker tick, so the captioned positions read as the
            // scale and the rest as the steps between them.
            let named = marker.title != nil
            context.setStrokeColor(
                (named ? UIColor.secondaryLabel : UIColor.tertiaryLabel).cgColor
            )
            context.move(to: CGPoint(x: centre, y: 0))
            context.addLine(to: CGPoint(x: centre, y: named ? namedTickHeight : tickHeight))
            context.strokePath()
        }
    }

    private func updateTravel() {
        guard let slider, slider.bounds.width > 0 else { return }
        let track = slider.trackRect(forBounds: slider.bounds)
        let leading = slider.thumbRect(
            forBounds: slider.bounds,
            trackRect: track,
            value: slider.minimumValue
        ).midX
        let trailing = slider.thumbRect(
            forBounds: slider.bounds,
            trackRect: track,
            value: slider.maximumValue
        ).midX
        guard trailing > leading else { return }
        // The strip and the slider are laid out to the same width by the stack that owns both,
        // so the slider's x values carry over without conversion.
        travel = leading...trailing
    }

    private func rebuildCaptions() {
        captions.forEach { $0.label.removeFromSuperview() }
        captions = markers.enumerated().compactMap { index, marker in
            guard let title = marker.title else { return nil }
            let label = UILabel()
            label.text = title
            label.font = .preferredFont(forTextStyle: .caption2)
            label.textColor = .secondaryLabel
            label.textAlignment = .center
            addSubview(label)
            return (index, label)
        }
        invalidateIntrinsicContentSize()
        setNeedsLayout()
        setNeedsDisplay()
    }

    private func x(for position: CGFloat) -> CGFloat {
        let span = travel.upperBound - travel.lowerBound
        guard span > 0 else { return bounds.midX }
        return travel.lowerBound + span * min(max(position, 0), 1)
    }
}

/// A labelled slider that lands only on named stops, with every stop marked underneath.
///
/// The manual video-quality axes are not free-running. Resolution is fixed when the
/// compression session is created (ADR-0100), so a value between two stops is not something
/// the encoder can be asked for -- and a slider that silently rounds wherever it stopped reads
/// as broken unless the stops it snaps to are visible.
final class SteppedSliderRow: UIView {
    struct Stop {
        /// Printed beside the row title when this stop is selected.
        let title: String
        /// Printed under this stop's tick, or nil to mark it without naming it.
        let caption: String?
    }

    /// Fires once per settled choice, not per pixel of drag.
    ///
    /// A resolution change recreates the compression session and discards every long-term
    /// reference inside it, so the next frame is a full keyframe. Committing while the thumb is
    /// still moving would spend one of those per stop dragged past -- on the link the user is
    /// dragging the slider to rescue.
    var onSelect: ((Int) -> Void)?

    var selectedIndex: Int {
        get { index(forSliderValue: slider.value) }
        set { apply(index: newValue) }
    }

    private let titleLabel = UILabel()
    private let valueLabel = UILabel()
    private let slider = UISlider()
    private let markerStrip = SliderMarkerStrip()
    private let stops: [Stop]

    init(title: String, stops: [Stop]) {
        self.stops = stops
        super.init(frame: .zero)
        configure(title: title)
    }

    required init?(coder: NSCoder) {
        stops = []
        super.init(coder: coder)
        configure(title: "")
    }

    private func configure(title: String) {
        titleLabel.text = title
        titleLabel.font = .preferredFont(forTextStyle: .body)

        valueLabel.font = .preferredFont(forTextStyle: .body)
        valueLabel.textColor = .secondaryLabel
        valueLabel.textAlignment = .right
        valueLabel.setContentHuggingPriority(.required, for: .horizontal)

        slider.minimumValue = 0
        slider.maximumValue = Float(max(stops.count - 1, 0))
        slider.isContinuous = true
        slider.addTarget(self, action: #selector(sliderMoved), for: .valueChanged)
        for event in [UIControl.Event.touchUpInside, .touchUpOutside, .touchCancel] {
            slider.addTarget(self, action: #selector(sliderReleased), for: event)
        }
        slider.accessibilityLabel = title

        markerStrip.slider = slider
        markerStrip.markers = stops.enumerated().map { index, stop in
            SliderMarkerStrip.Marker(
                position: stops.count > 1
                    ? CGFloat(index) / CGFloat(stops.count - 1)
                    : 0,
                title: stop.caption
            )
        }

        let header = UIStackView(arrangedSubviews: [titleLabel, valueLabel])
        header.axis = .horizontal
        header.spacing = 8

        let stack = UIStackView(arrangedSubviews: [header, slider, markerStrip])
        stack.axis = .vertical
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])

        apply(index: 0)
    }

    @objc private func sliderMoved() {
        // Snap the thumb while it moves, so the control reads as stepped rather than as a free
        // slider that quietly disagrees with the value printed beside it.
        apply(index: index(forSliderValue: slider.value))
    }

    @objc private func sliderReleased() {
        let settled = index(forSliderValue: slider.value)
        apply(index: settled)
        onSelect?(settled)
    }

    private func apply(index: Int) {
        guard !stops.isEmpty else { return }
        let clamped = min(max(index, 0), stops.count - 1)
        slider.value = Float(clamped)
        valueLabel.text = stops[clamped].title
        // Without this VoiceOver reads the raw slider float ("3"), which names the stop's
        // position in the list rather than the setting the user is choosing.
        slider.accessibilityValue = stops[clamped].title
    }

    private func index(forSliderValue value: Float) -> Int {
        guard !stops.isEmpty else { return 0 }
        return min(max(Int(value.rounded()), 0), stops.count - 1)
    }
}
