import AppKit
import Foundation
import os

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private enum HostStatusIcon {
        case idle
        case pairedIdle
        case pairing
        case screenRecordingRequired
        case accessibilityRequired
        case tailscaleRequired
        case pairingFailed
        case connecting
        case connected

        var accessibilityDescription: String {
            switch self {
            case .idle:
                "AgentDesk idle"
            case .pairedIdle:
                "AgentDesk paired idle"
            case .pairing:
                "AgentDesk pairing"
            case .screenRecordingRequired:
                "Screen Recording required"
            case .accessibilityRequired:
                "Accessibility required"
            case .tailscaleRequired:
                "Tailscale required"
            case .pairingFailed:
                "Pairing failed"
            case .connecting:
                "AgentDesk connecting"
            case .connected:
                "AgentDesk connected"
            }
        }

        var assetName: String? {
            switch self {
            case .idle, .pairedIdle:
                "StatusIcon"
            case .pairing,
                 .screenRecordingRequired,
                 .accessibilityRequired,
                 .tailscaleRequired,
                 .pairingFailed,
                 .connecting,
                 .connected:
                nil
            }
        }

        var symbolName: String? {
            switch self {
            case .idle, .pairedIdle:
                nil
            case .pairing:
                "qrcode"
            case .screenRecordingRequired, .accessibilityRequired:
                "exclamationmark.shield"
            case .tailscaleRequired, .pairingFailed:
                "exclamationmark.triangle"
            case .connecting:
                "antenna.radiowaves.left.and.right"
            case .connected:
                "dot.radiowaves.left.and.right"
            }
        }

        var isTemplate: Bool {
            true
        }

        var pointSize: CGFloat {
            assetName == nil ? 18 : 20
        }
    }

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
    private let spacesProvider = SpacesProvider()
    private let spaceThumbnailProvider = SpaceThumbnailProvider()
    private var spaceAgentController: SpaceAgentController?
    private var thumbnailsBroadcastTask: Task<Void, Never>?
    private var thumbnailEnabledClients: Set<DeviceFingerprint> = []
    private let frameSource: VideoFrameSource = MediaStack.makeFrameSource()
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
        installSpacesSwitchHandler()
        installSpacesChangeObserver()
        installThumbnailsBroadcast()
        startSpaceAgent()
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
        spaceAgentController?.stop()
        signalingServer?.stop()
    }

    private func configureStatusItem() {
        applyIcon(.idle)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
    }

    private func applyIcon(_ icon: HostStatusIcon) {
        let image: NSImage?
        if let assetName = icon.assetName {
            image = NSImage(named: assetName)
        } else if let symbolName = icon.symbolName {
            image = NSImage(systemSymbolName: symbolName, accessibilityDescription: icon.accessibilityDescription)
        } else {
            image = nil
        }

        image?.size = NSSize(width: icon.pointSize, height: icon.pointSize)
        image?.isTemplate = icon.isTemplate
        statusItem.button?.image = image
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.title = image == nil ? "AgentDesk" : ""
        statusItem.button?.toolTip = icon.accessibilityDescription
        statusItem.button?.setAccessibilityLabel(icon.accessibilityDescription)
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
            },
            inputChannelReadyHandler: { [weak self] fingerprint, server in
                Task { @MainActor in
                    self?.handleInputChannelReady(fingerprint, server: server)
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
        thumbnailEnabledClients.remove(fingerprint)
        spaceThumbnailProvider.setDemand(owner: .client(fingerprint.rawValue), enabled: false)
        sessions.endSession(fingerprint)
        signalingLogger.notice("session ended fingerprint=\(fingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func startMediaTransport(for active: ActiveSession, channel: SignalingChannel) {
        let transport = mediaFactory.make()
        sessions.attachTransport(transport, for: active.deviceFingerprint)
        let frameSource = self.frameSource
        let fingerprint = active.deviceFingerprint

        Task { [weak self, transport] in
            for await state in transport.connectionState {
                await self?.handleMediaConnectionState(state, for: fingerprint)
            }
        }

        // ADR-0005: input no longer rides the WebRTC data channel; the
        // input dispatch task is wired in handleInputChannelReady when
        // the client opens its dedicated WSS. Media transport here is
        // video-only.

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

    // ADR-0005: client opened its input WSS; wire the server's event
    // stream into the dispatcher. Off-MainActor like the previous
    // data-channel-input task (dispatcher owns its serial queue so
    // CGEvent.post never serialises behind UI work).
    private func handleInputChannelReady(_ fingerprint: DeviceFingerprint, server: InputChannelServer) {
        signalingLogger.notice("input channel ready fp=\(fingerprint.rawValue, privacy: .public)")
        sessions.attachInputChannelServer(server, for: fingerprint)
        // R11: push the current DesktopState as soon as the channel is
        // attached so the client can render the dots band immediately
        // on session start without waiting for a Spaces switch.
        if let state = spacesProvider.current() {
            server.pushDesktopState(state)
        }
        // ADR-0006 + D22: clients opt in to thumbnail capture via a
        // client-config frame. Demand is owner-scoped so the iPhone
        // strip and Space Agent cannot disable each other.
        let provider = spaceThumbnailProvider
        let clientFingerprint = fingerprint
        let thumbnailOwner = SpaceThumbnailDemandOwner.client(fingerprint.rawValue)
        server.configHandler = { [weak self, server] config in
            let enabled = config.thumbnailsEnabled
            let refresh = config.thumbnailRefresh
            Task { @MainActor [weak self, provider, thumbnailOwner, server] in
                guard let self else { return }
                if enabled {
                    self.thumbnailEnabledClients.insert(clientFingerprint)
                } else {
                    self.thumbnailEnabledClients.remove(clientFingerprint)
                    server.pushThumbnails([:])
                }
                provider.setDemand(owner: thumbnailOwner, enabled: enabled)
                if let spaceId = refresh {
                    provider.forceRefresh(spaceId: spaceId)
                }
            }
        }
        let dispatcher = inputDispatcher
        let logger = signalingLogger
        sessions.attachInputTask(
            Task { [server, dispatcher, logger] in
                for await input in server.events {
                    dispatcher.dispatch(input)
                }
                logger.notice("input event stream finished")
            },
            for: fingerprint
        )
    }

    // ADR-0006: drains the SpaceThumbnailProvider's emit stream and
    // fans the latest result out to every active input channel server.
    // Stays alive for the process lifetime; the provider gates capture
    // itself based on owner-scoped demand, and this loop only forwards
    // thumbnails to clients that explicitly opted in.
    private func installThumbnailsBroadcast() {
        let registry = sessions
        let provider = spaceThumbnailProvider
        thumbnailsBroadcastTask?.cancel()
        thumbnailsBroadcastTask = Task { @MainActor [weak self, weak registry, provider] in
            for await thumbnails in provider.thumbnails {
                guard let self, let registry else { return }
                let enabledClients = self.thumbnailEnabledClients
                for (fingerprint, server) in registry.allInputChannelServersByFingerprint()
                    where enabledClients.contains(fingerprint) {
                    server.pushThumbnails(thumbnails)
                }
            }
        }
    }

    private func startSpaceAgent() {
        let controller = SpaceAgentController(
            spacesProvider: spacesProvider,
            thumbnailProvider: spaceThumbnailProvider,
            commitStep: { [spacesProvider] delta in
                spacesProvider.commitStep(delta: delta)
            }
        )
        spaceAgentController = controller
        controller.start()
    }

    // R11: NSWorkspace publishes activeSpaceDidChangeNotification on
    // its OWN notification center (not NotificationCenter.default)
    // whenever the active Space changes, regardless of trigger.
    // Covers Mac-initiated switches (F3, four-finger swipe on the Mac
    // trackpad, full-screen entry/exit, Mission Control click) that
    // the iPhone-initiated path's explicit post-switch broadcast
    // alone would miss. The push is idempotent on the client; if our
    // own iPhone-initiated switch also triggers this observer, the
    // client just receives the same state twice.
    private func installSpacesChangeObserver() {
        let registry = sessions
        let provider = spacesProvider
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak registry] _ in
            guard let registry, let state = provider.current() else { return }
            for server in registry.allInputChannelServers() {
                server.pushDesktopState(state)
            }
        }
    }

    // R11: dispatcher streams each iPhone-side swipe phase
    // (Began / Changed* / Ended) into SpacesProvider, which posts a
    // dock-swipe CGEvent per phase. Dock animates Spaces driven by the
    // progress stream and commits-or-snaps-back at Ended. The post-
    // commit DesktopState broadcast is driven by the NSWorkspace
    // activeSpaceDidChange observer above; the gesture-streaming path
    // here does not need to broadcast (which would fire many times
    // mid-swipe).
    private func installSpacesSwitchHandler() {
        let provider = spacesProvider
        inputDispatcher.switchSpaceGestureHandler = { phase, progress, velocityX in
            provider.postDockSwipeFrame(phase: phase, progress: progress, velocityX: velocityX)
        }
        inputDispatcher.switchSpaceStepHandler = { delta in
            provider.commitStep(delta: delta)
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
            applyIcon(.pairing)
            popoverController.render(.pairing(url, QRCodeRenderer.image(for: url)))
        } catch is TailscaleRequiredError {
            signalingLogger.error("startPairing failed: tailscale required")
            applyIcon(.tailscaleRequired)
            popoverController.render(.tailscaleRequired)
        } catch {
            signalingLogger.error("startPairing failed: \(String(describing: error), privacy: .public)")
            applyIcon(.pairingFailed)
            popoverController.render(.idle)
        }
    }

    private func refreshConnectedState() {
        if !ScreenCaptureKitFrameSource.hasScreenRecordingPermission()
            && ProcessInfo.processInfo.environment["AGENTDESK_USE_TEST_PATTERN"] != "1" {
            applyIcon(.screenRecordingRequired)
            popoverController.render(.screenRecordingDenied)
            return
        }
        if !AXIsProcessTrusted() {
            applyIcon(.accessibilityRequired)
            popoverController.render(.accessibilityRequired)
            return
        }
        guard let record = try? pairing.approvedDevices().first else {
            applyIcon(.idle)
            popoverController.render(.idle)
            return
        }
        if sessions.isActive(record.deviceFingerprint) {
            applyIcon(.connected)
            popoverController.render(.connected(record))
        } else if sessions.isAttempting(record.deviceFingerprint) {
            applyIcon(.connecting)
            popoverController.render(.connecting(record))
        } else {
            applyIcon(.pairedIdle)
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
