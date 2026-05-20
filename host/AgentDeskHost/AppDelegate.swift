import AppKit
import Foundation

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let popoverController = PopoverViewController()
    private let pairing = Pairing()
    private var signalingServer: PairingSignalingServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureStatusItem()
        configurePopover()
        startSignalingServer()
        refreshConnectedState()
    }

    func applicationWillTerminate(_ notification: Notification) {
        signalingServer?.stop()
    }

    private func configureStatusItem() {
        statusItem.button?.image = NSImage(systemSymbolName: "display", accessibilityDescription: "AgentDesk idle")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
    }

    private func configurePopover() {
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 300, height: 340)
        popover.contentViewController = popoverController
        popoverController.onStartPairing = { [weak self] in
            self?.startPairing()
        }
        popoverController.onRevoke = { [weak self] fingerprint in
            try? self?.pairing.revoke(deviceFingerprint: fingerprint)
            self?.refreshConnectedState()
        }
    }

    private func startSignalingServer() {
        signalingServer = PairingSignalingServer(pairing: pairing) { [weak self] fingerprint, completion in
            self?.showApprovalSheet(for: fingerprint, completion: completion)
        }
        do {
            try signalingServer?.start()
        } catch {
            popoverController.render(.tailscaleRequired)
        }
    }

    private func startPairing() {
        do {
            let payload = try pairing.mintPairingPayload()
            let url = try payload.pairingURL()
            statusItem.button?.image = NSImage(systemSymbolName: "qrcode", accessibilityDescription: "AgentDesk pairing")
            popoverController.render(.pairing(url, QRCodeRenderer.image(for: url)))
        } catch is TailscaleRequiredError {
            statusItem.button?.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Tailscale required")
            popoverController.render(.tailscaleRequired)
        } catch {
            statusItem.button?.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Pairing failed")
            popoverController.render(.idle)
        }
    }

    private func refreshConnectedState() {
        if let record = try? pairing.approvedDevices().first {
            statusItem.button?.image = NSImage(systemSymbolName: "display.and.arrow.down", accessibilityDescription: "AgentDesk connected")
            popoverController.render(.connected(record))
        } else {
            statusItem.button?.image = NSImage(systemSymbolName: "display", accessibilityDescription: "AgentDesk idle")
            popoverController.render(.idle)
        }
    }

    private func showApprovalSheet(for fingerprint: DeviceFingerprint, completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Approve iPhone pairing"
        alert.informativeText = fingerprint.rawValue
        alert.addButton(withTitle: "Approve")
        alert.addButton(withTitle: "Reject")

        let window = popover.contentViewController?.view.window ?? NSApp.windows.first
        if let window {
            alert.beginSheetModal(for: window) { response in
                let approved = response == .alertFirstButtonReturn
                completion(approved)
                if approved {
                    self.refreshConnectedState()
                }
            }
        } else {
            completion(alert.runModal() == .alertFirstButtonReturn)
            refreshConnectedState()
        }
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }
}
