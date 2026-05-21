import AppKit
import Foundation
import os

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let popoverController = PopoverViewController()
    private let pairing = Pairing()
    private let launchAgentLogger = Logger(subsystem: Config.launchAgentLabel, category: "launchAgent")
    private let signalingLogger = Logger(subsystem: Config.launchAgentLabel, category: "signaling")
    private var signalingServer: PairingSignalingServer?
    private var activeSessions: Set<DeviceFingerprint> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        installLaunchAgent()
        configureStatusItem()
        configurePopover()
        startSignalingServer()
        refreshConnectedState()
    }

    func applicationWillTerminate(_ notification: Notification) {
        signalingServer?.stop()
    }

    private func configureStatusItem() {
        applyIcon(symbolName: "macbook.and.iphone", accessibilityDescription: "AgentDesk idle")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
    }

    private func applyIcon(symbolName: String, accessibilityDescription: String) {
        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityDescription)
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.title = image == nil ? "AgentDesk" : ""
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
        signalingServer = PairingSignalingServer(
            pairing: pairing,
            approvalHandler: { [weak self] fingerprint, completion in
                self?.showApprovalSheet(for: fingerprint, completion: completion)
            },
            sessionReadyHandler: { [weak self] active in
                Task { @MainActor in
                    self?.handleSessionReady(active)
                }
            },
            sessionEndedHandler: { [weak self] fingerprint in
                Task { @MainActor in
                    self?.handleSessionEnded(fingerprint)
                }
            }
        )
        do {
            try signalingServer?.start()
            signalingLogger.notice("signaling server started on port \(Int(Config.signalingPort), privacy: .public)")
        } catch {
            signalingLogger.error("signaling server start failed: \(String(describing: error), privacy: .public)")
            popoverController.render(.tailscaleRequired)
        }
    }

    private func handleSessionReady(_ active: ActiveSession) {
        activeSessions.insert(active.deviceFingerprint)
        signalingLogger.notice("session ready fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func handleSessionEnded(_ fingerprint: DeviceFingerprint) {
        activeSessions.remove(fingerprint)
        signalingLogger.notice("session ended fingerprint=\(fingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func startPairing() {
        do {
            let payload = try pairing.mintPairingPayload()
            let url = try payload.pairingURL()
            applyIcon(symbolName: "qrcode", accessibilityDescription: "AgentDesk pairing")
            popoverController.render(.pairing(url, QRCodeRenderer.image(for: url)))
        } catch is TailscaleRequiredError {
            applyIcon(symbolName: "exclamationmark.triangle", accessibilityDescription: "Tailscale required")
            popoverController.render(.tailscaleRequired)
        } catch {
            applyIcon(symbolName: "exclamationmark.triangle", accessibilityDescription: "Pairing failed")
            popoverController.render(.idle)
        }
    }

    private func refreshConnectedState() {
        if let record = try? pairing.approvedDevices().first {
            applyIcon(symbolName: "dot.radiowaves.left.and.right", accessibilityDescription: "AgentDesk connected")
            popoverController.render(.connected(record))
        } else {
            applyIcon(symbolName: "macbook.and.iphone", accessibilityDescription: "AgentDesk idle")
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

    private func installLaunchAgent() {
        let installer = LaunchAgentInstaller(
            plistURL: Config.launchAgentPlistURL,
            executableURL: Config.hostExecutableURL,
            label: Config.launchAgentLabel,
            runner: SystemLaunchctlRunner()
        )

        do {
            try installer.installIfNeeded()
        } catch {
            launchAgentLogger.error("LaunchAgent install failed: \(String(describing: error), privacy: .public)")
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
