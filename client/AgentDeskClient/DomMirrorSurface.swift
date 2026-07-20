import BrowserProjection
import Foundation
import OSLog
import UIKit
import WebKit

// ADR-0038 DOM mirror: an iOS shell around the shared BrowserProjection WKWebView. The bridge is
// one-directional for read-only v1:
//   - Outbound (native -> JS): deliver(rawJSON) -> window.__domMirrorDeliver(batch)
//   - Inbound  (JS -> native): the replayer posts a `domMirror` probe summarizing the reconstructed
//     DOM (marker attribute + node count) so the autonomous harness can assert the mirror worked
//     without a human; `domLog` carries JS errors/console to OSLog.
@MainActor
final class DomMirrorSurface: UIView {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "dom-mirror-surface")

    // Observers can watch the probe (e.g. tests); production just logs it.
    var onProbe: ((_ marker: String, _ nodes: Int) -> Void)?
    // ADR-0040: a tap in the replayer, mapped to page CSS-pixel coords, to be sent back to Chrome.
    var onTap: ((_ x: Double, _ y: Double) -> Void)?
    // ADR-0047: a scroll drag in the replayer. x/y are the page CSS-pixel anchor, dx/dy the finger
    // movement delta in page CSS px; sent back to Chrome to drive the real tab's scroll.
    var onScroll: ((_ x: Double, _ y: Double, _ dx: Double, _ dy: Double) -> Void)?

    // ADR-0047: forward a mirror scroll drag to the host, UNLESS the view is pinch-zoomed. Once the
    // WKWebView scrollView.zoomScale exceeds 1, a single-finger drag pans the magnified view locally
    // (intrinsic UIScrollView zoom-pan); also driving the host tab from the same drag is a two-input
    // collision, so we suppress the host-scroll and let the native pan own the gesture. The tap is
    // already suppressed JS-side (a drag is a drag), so a zoomed pan drives neither. Model: navigate
    // the page at 1x, inspect locally when zoomed. zoomScale is the authoritative zoom state (JS
    // visualViewport tracking of WKWebView pinch is unreliable), so the gate lives here, not in the JS.
    func handleScroll(x: Double, y: Double, dx: Double, dy: Double) {
        guard webView.scrollView.zoomScale <= 1.01 else { return }
        onScroll?(x, y, dx, dy)
    }

    private let projectionController = BrowserProjectionController()
    private var webView: WKWebView { projectionController.view }
    var projectionViewForTesting: WKWebView { projectionController.view }

    // ADR-0046 diagnostic status line (below the surface's top edge, i.e. below the Control | Agent |
    // Browser switcher). The surface owns its status state and re-renders the pills on each update
    // and on a 1s timer (so the "Xs ago" freshness advances even when no batch arrives).
    private let statusBar = UIView()
    private let statusStack = UIStackView()
    // ADR-0048: Desktop|Mobile device-emulation toggle. Its selected index is driven by the
    // authoritative host echo (setBridgeStatus), not the tap, so a host-side reset self-corrects it.
    private let emulateControl = UISegmentedControl(items: ["Desktop", "Mobile"])
    var onEmulateToggle: ((_ mobile: Bool) -> Void)?
    private var bridgeConnected = false
    private var recordingTab: Int?
    private var nodeCount: Int?
    private var batchCount = 0
    private var paused = false
    private var emulated = false
    private var lastBatchAt: Date?
    private var ageTimer: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupWebView()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupWebView()
    }

    private func setupWebView() {
        setupStatusBar()
        let wv = projectionController.view
        wv.translatesAutoresizingMaskIntoConstraints = false
        addSubview(wv) // ADR-0040: interactive -- taps are captured in the replayer and sent back
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: statusBar.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        projectionController.onProbe = { [weak self] marker, nodes in
            self?.handleProbe(marker: marker, nodes: nodes)
        }
        projectionController.onTap = { [weak self] x, y in
            self?.onTap?(x, y)
        }
        projectionController.onScroll = { [weak self] x, y, dx, dy in
            self?.handleScroll(x: x, y: y, dx: dx, dy: dy)
        }
        projectionController.onLog = { [weak self] message in
            self?.logger.error("dom-mirror JS: \(message, privacy: .public)")
        }
    }

    // MARK: - ADR-0046 status line

    private func setupStatusBar() {
        statusBar.translatesAutoresizingMaskIntoConstraints = false
        statusBar.backgroundColor = UIColor.black.withAlphaComponent(0.06)
        addSubview(statusBar)
        NSLayoutConstraint.activate([
            statusBar.topAnchor.constraint(equalTo: topAnchor),
            statusBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: trailingAnchor),
            // Tall enough (was 26) to seat the Desktop|Mobile control next to the diagnostic pills.
            statusBar.heightAnchor.constraint(equalToConstant: 34)
        ])

        // ADR-0048: the emulation control sits at the trailing edge; the pills fill from the leading
        // edge up to it. Compact height + small font so it fits the diagnostic bar.
        emulateControl.translatesAutoresizingMaskIntoConstraints = false
        emulateControl.selectedSegmentIndex = 0 // desktop until the host echo says otherwise
        emulateControl.setTitleTextAttributes([.font: UIFont.systemFont(ofSize: 11, weight: .medium)], for: .normal)
        emulateControl.addTarget(self, action: #selector(emulateChanged), for: .valueChanged)
        statusBar.addSubview(emulateControl)
        NSLayoutConstraint.activate([
            emulateControl.trailingAnchor.constraint(equalTo: statusBar.trailingAnchor, constant: -8),
            emulateControl.centerYAnchor.constraint(equalTo: statusBar.centerYAnchor),
            emulateControl.heightAnchor.constraint(equalToConstant: 26)
        ])

        statusStack.translatesAutoresizingMaskIntoConstraints = false
        statusStack.axis = .horizontal
        statusStack.spacing = 6
        statusStack.alignment = .center
        statusBar.addSubview(statusStack)
        NSLayoutConstraint.activate([
            statusStack.leadingAnchor.constraint(equalTo: statusBar.leadingAnchor, constant: 8),
            statusStack.trailingAnchor.constraint(lessThanOrEqualTo: emulateControl.leadingAnchor, constant: -8),
            statusStack.centerYAnchor.constraint(equalTo: statusBar.centerYAnchor)
        ])

        renderStatus()
        // Advance the "Xs ago" freshness even when no new batch arrives.
        ageTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.renderStatus() }
        }
    }

    // Granular setters, called by the VC from the wired lane callbacks. Each re-renders the line.
    // ADR-0048: `emulated` is the authoritative host state; it also drives the segmented control's
    // selected index (set only here, never in the periodic renderStatus, so the timer can't flicker the
    // control back between a tap and the host echo).
    func setBridgeStatus(connected: Bool, recordingTab tab: Int?, emulated emu: Bool) {
        bridgeConnected = connected; recordingTab = tab; emulated = emu
        emulateControl.selectedSegmentIndex = emu ? 1 : 0
        renderStatus()
    }
    func recordBatch() { lastBatchAt = Date(); batchCount += 1; renderStatus() }
    func setNodeCount(_ n: Int) { nodeCount = n; renderStatus() }
    func setPaused(_ p: Bool) { paused = p; renderStatus() }

    // ADR-0048: the user flipped Desktop|Mobile. Request the toggle; the selected index is authoritative
    // from the host echo (setBridgeStatus), so we don't commit local state here beyond the control's own
    // selection, which the echo confirms or corrects.
    @objc private func emulateChanged() {
        onEmulateToggle?(emulateControl.selectedSegmentIndex == 1)
    }

    private func renderStatus() {
        let ageMs = lastBatchAt.map { Int(Date().timeIntervalSince($0) * 1000) }
        let status = DomMirrorStatus(
            bridgeConnected: bridgeConnected, recordingTab: recordingTab,
            lastBatchAgeMs: ageMs, nodeCount: nodeCount, batchCount: batchCount, paused: paused,
            emulated: emulated)
        let chips = statusChips(status)
        statusStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for chip in chips { statusStack.addArrangedSubview(Self.makePill(chip)) }
    }

    private static func makePill(_ chip: StatusChip) -> UIView {
        let label = InsetLabel()
        label.text = chip.text
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = color(for: chip.severity)
        label.layer.cornerRadius = 5
        label.layer.masksToBounds = true
        return label
    }

    private static func color(for severity: StatusSeverity) -> UIColor {
        switch severity {
        case .ok: return UIColor.systemGreen.withAlphaComponent(0.85)
        case .warn: return UIColor.systemOrange.withAlphaComponent(0.9)
        case .off: return UIColor.systemGray
        }
    }

    // MARK: - Outbound: native -> webview

    // Deliver one raw DOM batch JSON ({t,tb,co,ev,meta}) to the replayer. Queued until loaded.
    func deliver(rawJSON: String) {
        projectionController.deliver(rawJSON: rawJSON)
    }

    func teardown() {
        ageTimer?.invalidate()
        ageTimer = nil
        projectionController.teardown()
    }

    private func handleProbe(marker: String, nodes: Int) {
        let line = "dom-mirror-probe marker=\(marker) nodes=\(nodes)"
        logger.notice("\(line, privacy: .public)")
        if ProcessInfo.processInfo.environment["AGENTDESK_DOM_MIRROR_PROBE_STDERR"] == "1" {
            FileHandle.standardError.write(Data(("[dom-mirror] " + line + "\n").utf8))
        }
        onProbe?(marker, nodes)
    }
}

// A UILabel with symmetric content insets, used for the status-line pills.
private final class InsetLabel: UILabel {
    private let insets = UIEdgeInsets(top: 2, left: 6, bottom: 2, right: 6)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right,
                      height: s.height + insets.top + insets.bottom)
    }
}
