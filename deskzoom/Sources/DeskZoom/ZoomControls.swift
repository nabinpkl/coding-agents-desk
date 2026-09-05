import AppKit

/// Zoom controls that live in the window's title bar.
///
/// Direction: a utility window for daily expert use, so these read as ordinary macOS window
/// chrome (system symbols, system control sizes) rather than custom-styled buttons. AppKit's
/// standard controls carry hover, pressed, focus-ring and disabled states already; the only
/// state this code owns is enablement at the zoom limits.
final class ZoomControls: NSTitlebarAccessoryViewController {
    /// One click of the title bar buttons. Matches the step other canvas tools use.
    private static let step: CGFloat = 1.25

    private let stepper = NSSegmentedControl()
    private let readout = NSTextField(labelWithString: "100%")
    private let fitButton = NSButton()
    private let actualSizeButton = NSButton()
    private let canvasSlider = NSSlider()
    private let canvasLabel = NSTextField(labelWithString: "")
    private var ladder: [VirtualDisplay.Canvas] = []

    /// Called with the zoom factor to apply around the canvas center. > 1 zooms in.
    var onZoom: ((CGFloat) -> Void)?
    var onFit: (() -> Void)?
    var onActualSize: (() -> Void)?
    /// Called with the canvas the slider was moved to.
    var onCanvasChange: ((VirtualDisplay.Canvas) -> Void)?

    init() {
        super.init(nibName: nil, bundle: nil)
        layoutAttribute = .right
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        stepper.segmentStyle = .separated
        stepper.trackingMode = .momentary
        stepper.segmentCount = 2
        stepper.setImage(NSImage(systemSymbolName: "minus.magnifyingglass", accessibilityDescription: "Zoom out"), forSegment: 0)
        stepper.setImage(NSImage(systemSymbolName: "plus.magnifyingglass", accessibilityDescription: "Zoom in"), forSegment: 1)
        stepper.target = self
        stepper.action = #selector(stepperFired)
        stepper.setAccessibilityIdentifier("zoom-stepper")

        // A value the reader is meant to read, so it takes primary ink, not a muted caption tone.
        readout.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        readout.textColor = .labelColor
        readout.alignment = .right
        readout.setAccessibilityIdentifier("zoom-readout")
        readout.widthAnchor.constraint(equalToConstant: 46).isActive = true

        fitButton.title = "Fit"
        fitButton.bezelStyle = .rounded
        fitButton.controlSize = .small
        fitButton.target = self
        fitButton.action = #selector(fitFired)
        fitButton.toolTip = "Show the whole virtual display (⌘0)"
        fitButton.setAccessibilityIdentifier("zoom-fit")

        // Desk size and sharpness are one axis, not two: a canvas small enough to be backed at two pixels
        // per point is sharp, a larger one is not, and the slider walks that trade rather than hiding it
        // behind a 1x/2x switch that says nothing about what it costs.
        canvasSlider.controlSize = .small
        canvasSlider.allowsTickMarkValuesOnly = true
        canvasSlider.sliderType = .linear
        canvasSlider.target = self
        canvasSlider.action = #selector(canvasSliderMoved)
        // Live: the label follows the knob as it moves, and the display change behind it is debounced by
        // the delegate. Waiting for the knob to be released made choosing a rung a guess-and-check.
        canvasSlider.isContinuous = true
        canvasSlider.setAccessibilityIdentifier("canvas-slider")
        canvasSlider.widthAnchor.constraint(equalToConstant: 110).isActive = true

        canvasLabel.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        canvasLabel.textColor = .labelColor
        canvasLabel.setAccessibilityIdentifier("canvas-label")
        canvasLabel.widthAnchor.constraint(equalToConstant: 122).isActive = true

        actualSizeButton.title = "1:1"
        actualSizeButton.bezelStyle = .rounded
        actualSizeButton.controlSize = .small
        actualSizeButton.target = self
        actualSizeButton.action = #selector(actualSizeFired)
        actualSizeButton.toolTip = "Show the canvas at its own size, one canvas point per screen point (⌘1)"
        actualSizeButton.setAccessibilityIdentifier("zoom-actual-size")

        let stack = NSStackView(views: [canvasLabel, canvasSlider, readout, stepper, actualSizeButton, fitButton])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 12)
        // A title bar accessory is laid out from its frame, not its constraints; without an explicit
        // size the stack comes up zero-width and the whole accessory is invisible.
        stack.translatesAutoresizingMaskIntoConstraints = true
        stack.frame = NSRect(origin: .zero, size: CGSize(width: stack.fittingSize.width, height: max(28, stack.fittingSize.height)))
        view = stack
    }

    /// The rungs the display offers, and which one it is on now.
    func setLadder(_ ladder: [VirtualDisplay.Canvas], current width: CGFloat) {
        loadViewIfNeeded()
        self.ladder = ladder
        canvasSlider.minValue = 0
        canvasSlider.maxValue = Double(max(0, ladder.count - 1))
        canvasSlider.numberOfTickMarks = ladder.count
        canvasSlider.isEnabled = ladder.count > 1
        let index = ladder.firstIndex { $0.size.width == width } ?? max(0, ladder.count - 1)
        canvasSlider.doubleValue = Double(index)
        canvasLabel.stringValue = ladder.indices.contains(index) ? ladder[index].label : ""
        canvasLabel.toolTip = "Desk size and sharpness. Smaller canvases are drawn at two pixels per point."
    }

    @objc private func canvasSliderMoved() {
        let index = Int(canvasSlider.doubleValue.rounded())
        guard ladder.indices.contains(index), ladder[index].label != canvasLabel.stringValue else { return }
        canvasLabel.stringValue = ladder[index].label
        onCanvasChange?(ladder[index])
    }

    /// Enablement is the one state AppKit cannot infer: a disabled segment leaves the tab order
    /// and rejects clicks, so the buttons stop lying about what they can do at the zoom limits.
    func update(with viewport: Viewport) {
        loadViewIfNeeded()
        stepper.setEnabled(viewport.canZoomOut, forSegment: 0)
        stepper.setEnabled(viewport.canZoomIn, forSegment: 1)
        fitButton.isEnabled = viewport.canZoomOut
        readout.stringValue = "\(Int((viewport.magnification * 100).rounded()))%"
        readout.toolTip = "Each screen point shows \(String(format: "%.1f", 1 / viewport.magnification)) virtual display points"
    }

    @objc private func stepperFired() {
        onZoom?(stepper.selectedSegment == 0 ? 1 / Self.step : Self.step)
    }

    @objc private func fitFired() {
        onFit?()
    }

    @objc private func actualSizeFired() {
        onActualSize?()
    }
}
