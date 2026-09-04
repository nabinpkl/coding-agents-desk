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

    /// Called with the zoom factor to apply around the canvas center. > 1 zooms in.
    var onZoom: ((CGFloat) -> Void)?
    var onFit: (() -> Void)?

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

        let stack = NSStackView(views: [readout, stepper, fitButton])
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
}
