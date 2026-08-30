import UIKit

/// The native shell's complete desktop navigation: two tabs and no viewer behavior.
final class DesktopViewerTabBar: UIView {
    var onSelection: ((DesktopViewerMode) -> Void)?

    private let modeControl = UISegmentedControl(items: ["Native", "WebView"])
    private let separator = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    func select(_ mode: DesktopViewerMode) {
        modeControl.selectedSegmentIndex = mode.rawValue
    }

    private func configure() {
        backgroundColor = .systemBackground.withAlphaComponent(0.94)
        accessibilityIdentifier = "desktop-viewer-tab-bar"

        modeControl.selectedSegmentIndex = DesktopViewerMode.native.rawValue
        modeControl.accessibilityIdentifier = "desktop-viewer-tabs"
        modeControl.addTarget(self, action: #selector(selectionChanged), for: .valueChanged)
        modeControl.translatesAutoresizingMaskIntoConstraints = false
        addSubview(modeControl)

        separator.backgroundColor = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(separator)

        NSLayoutConstraint.activate([
            modeControl.centerXAnchor.constraint(equalTo: centerXAnchor),
            modeControl.centerYAnchor.constraint(equalTo: centerYAnchor),
            modeControl.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            modeControl.heightAnchor.constraint(equalToConstant: 32),
            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: bottomAnchor),
            separator.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
        ])
    }

    @objc private func selectionChanged() {
        guard let mode = DesktopViewerMode(rawValue: modeControl.selectedSegmentIndex) else {
            preconditionFailure("Desktop viewer tab index is outside DesktopViewerMode")
        }
        onSelection?(mode)
    }
}
