import AppKit

@MainActor
final class AgentWindowSplitView: NSView {
    static let defaultTerminalFraction: CGFloat = 0.38
    static let terminalFractionRange: ClosedRange<CGFloat> = 0.25...0.65
    static let accessibilityResizeStep: CGFloat = 0.05

    let dividerViewForTesting = AgentWindowResizeHandle()

    private let feedView: NSView
    private let terminalView: NSView
    private lazy var dividerAccessibilityElement = AgentWindowResizeProxyAccessibilityElement(
        parentView: self,
        sourceView: dividerViewForTesting
    )
    private lazy var terminalAccessibilityElement = AgentWindowTerminalProxyAccessibilityElement(
        parentView: self,
        sourceView: terminalView
    )
    private var closedConstraints: [NSLayoutConstraint] = []
    private var openConstraints: [NSLayoutConstraint] = []
    private var terminalHeightConstraint: NSLayoutConstraint?

    private(set) var isTerminalOpen = false
    private(set) var terminalFraction = defaultTerminalFraction

    init(feedView: NSView, terminalView: NSView) {
        self.feedView = feedView
        self.terminalView = terminalView
        super.init(frame: .zero)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Agent panel content")
        feedView.translatesAutoresizingMaskIntoConstraints = false
        terminalView.setAccessibilityIdentifier(
            AgentWindowAccessibilityIdentifiers.terminalContent
        )
        addSubview(feedView)
        closedConstraints = [
            feedView.leadingAnchor.constraint(equalTo: leadingAnchor),
            feedView.trailingAnchor.constraint(equalTo: trailingAnchor),
            feedView.topAnchor.constraint(equalTo: topAnchor),
            feedView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ]
        NSLayoutConstraint.activate(closedConstraints)

        dividerViewForTesting.onDrag = { [weak self] dividerPosition in
            guard let self, self.bounds.height > 0 else { return }
            self.setTerminalFraction(dividerPosition / self.bounds.height)
        }
        dividerViewForTesting.onIncrement = { [weak self] in
            self?.stepTerminalFraction(by: Self.accessibilityResizeStep)
        }
        dividerViewForTesting.onDecrement = { [weak self] in
            self?.stepTerminalFraction(by: -Self.accessibilityResizeStep)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("AgentWindowSplitView does not support Interface Builder")
    }

    override func layout() {
        updateTerminalHeight()
        super.layout()
    }

    override func accessibilityChildren() -> [Any]? {
        var children: [Any] = [feedView]
        if isTerminalOpen {
            children.append(dividerAccessibilityElement)
            children.append(terminalAccessibilityElement)
        }
        return NSAccessibility.unignoredChildren(from: children)
    }

    func setTerminalOpen(_ open: Bool) {
        guard open != isTerminalOpen else { return }
        isTerminalOpen = open
        if open {
            installTerminalViews()
        } else {
            removeTerminalViews()
        }
        needsLayout = true
    }

    func setTerminalFraction(_ fraction: CGFloat) {
        terminalFraction = min(
            max(fraction, Self.terminalFractionRange.lowerBound),
            Self.terminalFractionRange.upperBound
        )
        updateTerminalHeight()
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    private func installTerminalViews() {
        NSLayoutConstraint.deactivate(closedConstraints)
        dividerViewForTesting.translatesAutoresizingMaskIntoConstraints = false
        terminalView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(dividerViewForTesting)
        addSubview(terminalView)

        let height = terminalView.heightAnchor.constraint(equalToConstant: 0)
        terminalHeightConstraint = height
        openConstraints = [
            feedView.leadingAnchor.constraint(equalTo: leadingAnchor),
            feedView.trailingAnchor.constraint(equalTo: trailingAnchor),
            feedView.topAnchor.constraint(equalTo: topAnchor),
            feedView.bottomAnchor.constraint(equalTo: dividerViewForTesting.topAnchor),
            dividerViewForTesting.leadingAnchor.constraint(equalTo: leadingAnchor),
            dividerViewForTesting.trailingAnchor.constraint(equalTo: trailingAnchor),
            dividerViewForTesting.heightAnchor.constraint(equalToConstant: 8),
            dividerViewForTesting.bottomAnchor.constraint(equalTo: terminalView.topAnchor),
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
            height,
        ]
        NSLayoutConstraint.activate(openConstraints)
        updateTerminalHeight()
    }

    private func removeTerminalViews() {
        NSLayoutConstraint.deactivate(openConstraints)
        openConstraints.removeAll(keepingCapacity: false)
        terminalHeightConstraint = nil
        terminalView.removeFromSuperview()
        dividerViewForTesting.removeFromSuperview()
        NSLayoutConstraint.activate(closedConstraints)
    }

    private func updateTerminalHeight() {
        guard isTerminalOpen else { return }
        terminalHeightConstraint?.constant = bounds.height * terminalFraction
        dividerViewForTesting.setAccessibilityValue(NSNumber(value: Double(terminalFraction)))
    }

    private func stepTerminalFraction(by delta: CGFloat) {
        setTerminalFraction(terminalFraction + delta)
    }
}

private class AgentWindowProxyAccessibilityElement: NSAccessibilityElement {
    nonisolated(unsafe) private weak var parentView: NSView?
    nonisolated(unsafe) fileprivate weak var sourceView: NSView?

    init(
        parentView: NSView,
        sourceView: NSView,
        role: NSAccessibility.Role,
        identifier: String,
        label: String,
        help: String? = nil
    ) {
        self.parentView = parentView
        self.sourceView = sourceView
        super.init()
        setAccessibilityParent(parentView)
        setAccessibilityElement(true)
        setAccessibilityRole(role)
        setAccessibilityIdentifier(identifier)
        setAccessibilityLabel(label)
        if let help {
            setAccessibilityHelp(help)
        }
    }

    override func accessibilityFrameInParentSpace() -> NSRect {
        sourceView?.frame ?? .zero
    }
}

private final class AgentWindowResizeProxyAccessibilityElement: AgentWindowProxyAccessibilityElement {
    init(parentView: NSView, sourceView: NSView) {
        super.init(
            parentView: parentView,
            sourceView: sourceView,
            role: .splitter,
            identifier: AgentWindowAccessibilityIdentifiers.terminalSplitter,
            label: "Resize agent terminal",
            help: "Use increment and decrement accessibility actions to resize the agent terminal."
        )
    }

    override func accessibilityPerformIncrement() -> Bool {
        sourceView?.accessibilityPerformIncrement() ?? false
    }

    override func accessibilityPerformDecrement() -> Bool {
        sourceView?.accessibilityPerformDecrement() ?? false
    }
}

private final class AgentWindowTerminalProxyAccessibilityElement: AgentWindowProxyAccessibilityElement {
    init(parentView: NSView, sourceView: NSView) {
        super.init(
            parentView: parentView,
            sourceView: sourceView,
            role: .group,
            identifier: AgentWindowAccessibilityIdentifiers.terminalContent,
            label: "Agent terminal",
            help: "Press to focus the native terminal."
        )
    }

    override func accessibilityPerformPress() -> Bool {
        sourceView?.accessibilityPerformPress() ?? false
    }
}

@MainActor
final class AgentWindowResizeHandle: NSView {
    var onDrag: ((CGFloat) -> Void)?
    var onIncrement: (() -> Void)?
    var onDecrement: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
        setAccessibilityIdentifier(AgentWindowAccessibilityIdentifiers.terminalSplitter)
        setAccessibilityLabel("Resize agent terminal")
        setAccessibilityHelp("Use increment and decrement accessibility actions to resize the agent terminal.")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("AgentWindowResizeHandle does not support Interface Builder")
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeUpDown)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let superview else { return }
        let point = superview.convert(event.locationInWindow, from: nil)
        onDrag?(point.y)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.minX, y: bounds.midY, width: bounds.width, height: 1).fill()
    }

    override func accessibilityPerformIncrement() -> Bool {
        onIncrement?()
        return true
    }

    override func accessibilityPerformDecrement() -> Bool {
        onDecrement?()
        return true
    }
}
