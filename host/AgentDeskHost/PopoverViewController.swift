import AppKit
import Foundation

enum HostPairingViewState {
    case idle
    case scanning
    case devicePicker([TailnetDeviceOption])
    case pairingOffered(String)
    case pairing(URL, NSImage?)
    case pairedNoActiveSession(PairedDeviceRecord)
    case connecting(PairedDeviceRecord)
    case connected(PairedDeviceRecord)
    case tailscaleRequired
    case screenRecordingDenied
    case accessibilityRequired
}

final class PopoverViewController: NSViewController {
    var onStartPairing: (() -> Void)?
    var onPairDevice: ((TailnetDeviceOption) -> Void)?
    var onRevoke: ((DeviceFingerprint) -> Void)?
    var onRequestScreenRecording: (() -> Void)?
    var onRequestAccessibility: (() -> Void)?
    var onQuit: (() -> Void)?

    private let stack = NSStackView()
    private var connectedFingerprint: DeviceFingerprint?
    // ADR-0019: maps each device-picker button to the tailnet device it pairs, so
    // a single action selector can route the tap to onPairDevice.
    private var deviceOptionByButton: [ObjectIdentifier: TailnetDeviceOption] = [:]

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 340))
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -18)
        ])
        render(.idle)
    }

    func render(_ state: HostPairingViewState) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        connectedFingerprint = nil
        deviceOptionByButton.removeAll()

        switch state {
        case .idle:
            label("AgentDesk Host", font: .boldSystemFont(ofSize: 16))
            label("No paired device", font: .systemFont(ofSize: 13))
            button(title: "Pair iPhone", action: #selector(startPairing))
        case .scanning:
            label("Scanning for devices", font: .boldSystemFont(ofSize: 16))
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(spinner)
            label("Looking for iPhones running AgentDesk on your tailnet. Open AgentDesk on the iPhone if it is not already.", font: .systemFont(ofSize: 12))
        case .devicePicker(let devices):
            label("Pair a device", font: .boldSystemFont(ofSize: 16))
            if devices.isEmpty {
                label("No tailnet devices found. Make sure the iPhone is on the same tailnet and AgentDesk is open on it.", font: .systemFont(ofSize: 12))
            } else {
                label("Pick the iPhone to pair. Open AgentDesk on it first.", font: .systemFont(ofSize: 12))
                for device in devices {
                    deviceRow(device)
                }
            }
            button(title: "Refresh", action: #selector(startPairing))
        case .pairingOffered(let deviceName):
            label("Pairing offer sent", font: .boldSystemFont(ofSize: 16))
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(spinner)
            label("Sent to \(deviceName). Open AgentDesk on it if it is not already; it will connect automatically.", font: .systemFont(ofSize: 12))
            button(title: "Back", action: #selector(startPairing))
        case .pairing(let url, let image):
            label("Scan to pair", font: .boldSystemFont(ofSize: 16))
            if let image {
                let imageView = NSImageView(image: image)
                imageView.imageScaling = .scaleProportionallyUpOrDown
                imageView.translatesAutoresizingMaskIntoConstraints = false
                stack.addArrangedSubview(imageView)
                NSLayoutConstraint.activate([
                    imageView.widthAnchor.constraint(equalToConstant: 220),
                    imageView.heightAnchor.constraint(equalToConstant: 220)
                ])
            }
            label("\(url.absoluteString.utf8.count) bytes", font: .monospacedSystemFont(ofSize: 11, weight: .regular))
        case .pairedNoActiveSession(let record):
            connectedFingerprint = record.deviceFingerprint
            label("Paired", font: .boldSystemFont(ofSize: 16))
            label(deviceDisplayName(record), font: .systemFont(ofSize: 13, weight: .medium))
            label("Paired but not currently connected.", font: .systemFont(ofSize: 12))
            label(record.deviceFingerprint.rawValue, font: .monospacedSystemFont(ofSize: 10, weight: .regular), lineBreakMode: .byTruncatingMiddle)
            button(title: "Revoke", action: #selector(revoke))
        case .connecting(let record):
            connectedFingerprint = record.deviceFingerprint
            label("Connecting", font: .boldSystemFont(ofSize: 16))
            label(deviceDisplayName(record), font: .systemFont(ofSize: 13, weight: .medium))
            label(record.deviceFingerprint.rawValue, font: .monospacedSystemFont(ofSize: 10, weight: .regular), lineBreakMode: .byTruncatingMiddle)
        case .connected(let record):
            connectedFingerprint = record.deviceFingerprint
            label("Connected", font: .boldSystemFont(ofSize: 16))
            label(deviceDisplayName(record), font: .systemFont(ofSize: 13, weight: .medium))
            label(record.deviceFingerprint.rawValue, font: .monospacedSystemFont(ofSize: 10, weight: .regular), lineBreakMode: .byTruncatingMiddle)
            if let lastSeenAt = record.lastSeenAt {
                label("Last seen \(Date(timeIntervalSince1970: TimeInterval(lastSeenAt)).formatted())", font: .systemFont(ofSize: 12))
            } else {
                label("Last seen pending", font: .systemFont(ofSize: 12))
            }
            button(title: "Revoke", action: #selector(revoke))
        case .tailscaleRequired:
            label("Tailscale required", font: .boldSystemFont(ofSize: 16))
            label("Install Tailscale and make this Mac visible on the tailnet.", font: .systemFont(ofSize: 12))
        case .screenRecordingDenied:
            label("Screen Recording required", font: .boldSystemFont(ofSize: 16))
            label("AgentDesk needs Screen Recording to share this Mac's display. Open System Settings, enable AgentDeskHost under Privacy & Security > Screen Recording, then relaunch.", font: .systemFont(ofSize: 12))
            button(title: "Open System Settings", action: #selector(requestScreenRecording))
        case .accessibilityRequired:
            label("Accessibility required", font: .boldSystemFont(ofSize: 16))
            label("AgentDesk needs Accessibility to forward iPhone gestures to the Mac cursor. Open System Settings, enable AgentDeskHost under Privacy & Security > Accessibility.", font: .systemFont(ofSize: 12))
            button(title: "Open System Settings", action: #selector(requestAccessibility))
        }

        versionFooter()
        separator()
        button(title: "Quit AgentDesk", action: #selector(quit))
    }

    // Build identity so it is obvious which host build is running: marketing
    // version plus the embedded short git sha (the numeric build number stays
    // reserved for App Store semantics on the client).
    private func versionFooter() {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let sha = (info?["AgentDeskGitSHA"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
        label("v\(short) \(sha)", font: .monospacedSystemFont(ofSize: 10, weight: .regular))
    }

    @objc private func requestScreenRecording() {
        onRequestScreenRecording?()
    }

    @objc private func requestAccessibility() {
        onRequestAccessibility?()
    }

    @objc private func startPairing() {
        onStartPairing?()
    }

    @objc private func pairDeviceTapped(_ sender: NSButton) {
        guard let device = deviceOptionByButton[ObjectIdentifier(sender)] else { return }
        onPairDevice?(device)
    }

    private func deviceDisplayName(_ record: PairedDeviceRecord) -> String {
        if let name = record.name, !name.isEmpty {
            return name
        }
        return "Unnamed device"
    }

    private func deviceRow(_ device: TailnetDeviceOption) {
        // iOS reports its Tailscale hostname as "localhost", so the hostname
        // alone is not identifiable. Include the tailnet IPv4, which matches the
        // "This device:" line on the iPhone's own unpaired screen.
        var title = "\(device.hostname) (\(device.os)) \(device.ipv4)"
        if !device.online {
            title += " (offline)"
        }
        let button = NSButton(title: title, target: self, action: #selector(pairDeviceTapped(_:)))
        button.bezelStyle = .rounded
        button.isEnabled = device.online
        deviceOptionByButton[ObjectIdentifier(button)] = device
        stack.addArrangedSubview(button)
    }

    @objc private func revoke() {
        guard let connectedFingerprint else { return }
        onRevoke?(connectedFingerprint)
    }

    @objc private func quit() {
        onQuit?()
    }

    private func label(_ text: String, font: NSFont, lineBreakMode: NSLineBreakMode = .byWordWrapping) {
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.alignment = .center
        label.lineBreakMode = lineBreakMode
        label.maximumNumberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(label)
        label.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true
    }

    private func button(title: String, action: Selector) {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        stack.addArrangedSubview(button)
    }

    private func separator() {
        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(separator)
        separator.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
}
