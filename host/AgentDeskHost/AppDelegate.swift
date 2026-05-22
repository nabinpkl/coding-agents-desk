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
    private let sessions = SessionRegistry()
    private let mediaFactory: MediaTransportFactory = MediaStack.makeFactory()
    private let inputDispatcher = InputDispatcher()
    private var pairingSignalSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        installLaunchAgent()
        configureStatusItem()
        configurePopover()
        bootstrapTLSIdentity()
        startSignalingServer()
        installPairingSignalHandler()
        refreshConnectedState()
        if !ScreenCaptureKitFrameSource.hasScreenRecordingPermission() {
            ScreenCaptureKitFrameSource.requestScreenRecordingPermission()
        }
        // R9.4: prompt for Accessibility once at launch. The system suppresses
        // re-prompts after the first answer, so calling this every cold start
        // is cheap and the dialog only appears when the user has not yet
        // decided. The string literal matches kAXTrustedCheckOptionPrompt's
        // CFString value; using the constant directly trips Swift 6
        // concurrency-safety checks.
        let promptOptions = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(promptOptions)
    }

    private func bootstrapTLSIdentity() {
        do {
            let identity = try TailscaleStatusDiscovery().currentIdentity()
            let loader = TLSIdentityLoader(
                certURL: Config.tlsCertURL,
                keyURL: Config.tlsKeyURL,
                identityURL: Config.tlsIdentityURL
            )
            try loader.bootstrapCertViaTailscale(fqdn: identity.fqdn)
        } catch {
            signalingLogger.error("tls bootstrap failed: \(String(describing: error), privacy: .public)")
        }
    }

    // SIGUSR1 fires startPairing on the main queue so `just pair-iphone` can
    // mint a fresh URL without a menubar click. Signal is local-uid-only;
    // same trust model as the menubar button.
    private func installPairingSignalHandler() {
        signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in
            self?.signalingLogger.notice("SIGUSR1 received; starting pairing")
            self?.startPairing()
        }
        source.resume()
        pairingSignalSource = source
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
        popoverController.onRequestScreenRecording = {
            ScreenCaptureKitFrameSource.requestScreenRecordingPermission()
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(url)
            }
        }
        popoverController.onRequestAccessibility = {
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func startSignalingServer() {
        signalingServer = PairingSignalingServer(
            pairing: pairing,
            approvalHandler: { [weak self] fingerprint, completion in
                self?.showApprovalSheet(for: fingerprint, completion: completion)
            },
            sessionAttemptStartedHandler: { [weak self] fingerprint in
                Task { @MainActor in
                    self?.handleSessionAttemptStarted(fingerprint)
                }
            },
            sessionReadyHandler: { [weak self] active, channel in
                Task { @MainActor in
                    self?.handleSessionReady(active, channel: channel)
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

    private func handleSessionAttemptStarted(_ fingerprint: DeviceFingerprint) {
        sessions.noteAttempt(fingerprint)
        signalingLogger.notice("session attempt started fingerprint=\(fingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func handleSessionReady(_ active: ActiveSession, channel: SignalingChannel) {
        sessions.noteReady(active, channel: channel)
        signalingLogger.notice("session ready fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public)")
        startMediaTransport(for: active, channel: channel)
        refreshConnectedState()
    }

    private func handleSessionEnded(_ fingerprint: DeviceFingerprint) {
        sessions.endSession(fingerprint)
        signalingLogger.notice("session ended fingerprint=\(fingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func startMediaTransport(for active: ActiveSession, channel: SignalingChannel) {
        let transport = mediaFactory.make()
        sessions.attachTransport(transport, for: active.deviceFingerprint)
        let frameSource = MediaStack.makeFrameSource()
        let fingerprint = active.deviceFingerprint

        Task { [weak self, transport] in
            for await state in transport.connectionState {
                await self?.handleMediaConnectionState(state, for: fingerprint)
            }
        }

        // R9.1+R9.3: forward incoming input bytes to the dispatcher.
        // Dispatcher owns its own serial queue so no MainActor hop is
        // needed; serializing CGEvent.post behind UI work produced
        // visible cursor cadence stalls.
        let dispatcher = inputDispatcher
        let logger = signalingLogger
        sessions.attachInputTask(
            Task { [transport, dispatcher, logger] in
                let decoder = JSONDecoder()
                for await data in transport.inputEvents {
                    guard let input = try? decoder.decode(NormalizedInput.self, from: data) else {
                        logger.error("input decode failed; \(data.count, privacy: .public) bytes")
                        continue
                    }
                    dispatcher.dispatch(input)
                }
            },
            for: fingerprint
        )

        Task { [signalingLogger, transport, channel, frameSource] in
            do {
                try await transport.start(
                    role: .offerer,
                    signaling: channel,
                    videoSource: frameSource,
                    videoSink: nil
                )
                signalingLogger.notice("media transport started")
            } catch {
                signalingLogger.error("media transport start failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func handleMediaConnectionState(_ state: MediaConnectionState, for fingerprint: DeviceFingerprint) {
        signalingLogger.notice("media state=\(String(describing: state), privacy: .public) fingerprint=\(fingerprint.rawValue, privacy: .public)")
        switch state {
        case .connecting:
            break
        case .connected:
            sessions.cancelIceGrace(for: fingerprint)
        case .disconnected:
            sessions.scheduleIceGrace(
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    guard !Task.isCancelled else { return }
                    self?.terminateMediaSession(for: fingerprint, reason: "ice-disconnected-grace")
                },
                for: fingerprint
            )
        case .failed, .closed:
            sessions.cancelIceGrace(for: fingerprint)
            terminateMediaSession(for: fingerprint, reason: "media-\(state)")
        }
    }

    private func terminateMediaSession(for fingerprint: DeviceFingerprint, reason: String) {
        signalingLogger.notice("terminating session reason=\(reason, privacy: .public) fingerprint=\(fingerprint.rawValue, privacy: .public)")
        if let channel = sessions.signalingChannel(for: fingerprint) as? WebSocketSignalingChannel {
            channel.close()
        }
        // connectionDidClose on the NWConnection fires sessionEndedHandler
        // which calls sessions.endSession via handleSessionEnded, tearing
        // down transport / tasks / timers in one place.
    }

    private func startPairing() {
        do {
            let payload = try pairing.mintPairingPayload()
            let url = try payload.pairingURL()
            signalingLogger.notice("pairing URL minted: \(url.absoluteString, privacy: .public)")
            try? url.absoluteString.write(to: Config.devLastPairURLPath, atomically: true, encoding: .utf8)
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
        if !ScreenCaptureKitFrameSource.hasScreenRecordingPermission()
            && ProcessInfo.processInfo.environment["AGENTDESK_USE_TEST_PATTERN"] != "1" {
            applyIcon(symbolName: "exclamationmark.shield", accessibilityDescription: "Screen Recording required")
            popoverController.render(.screenRecordingDenied)
            return
        }
        if !AXIsProcessTrusted() {
            applyIcon(symbolName: "exclamationmark.shield", accessibilityDescription: "Accessibility required")
            popoverController.render(.accessibilityRequired)
            return
        }
        guard let record = try? pairing.approvedDevices().first else {
            applyIcon(symbolName: "macbook.and.iphone", accessibilityDescription: "AgentDesk idle")
            popoverController.render(.idle)
            return
        }
        if sessions.isActive(record.deviceFingerprint) {
            applyIcon(symbolName: "dot.radiowaves.left.and.right", accessibilityDescription: "AgentDesk connected")
            popoverController.render(.connected(record))
        } else if sessions.isAttempting(record.deviceFingerprint) {
            applyIcon(symbolName: "antenna.radiowaves.left.and.right", accessibilityDescription: "AgentDesk connecting")
            popoverController.render(.connecting(record))
        } else {
            applyIcon(symbolName: "macbook.and.iphone.slash", accessibilityDescription: "AgentDesk paired idle")
            popoverController.render(.pairedNoActiveSession(record))
        }
    }

    private func showApprovalSheet(for fingerprint: DeviceFingerprint, completion: @escaping (Bool) -> Void) {
        if ProcessInfo.processInfo.environment["AGENTDESK_AUTO_APPROVE"] == "1" {
            signalingLogger.notice("AGENTDESK_AUTO_APPROVE=1; auto-approving \(fingerprint.rawValue, privacy: .public)")
            completion(true)
            refreshConnectedState()
            return
        }
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
