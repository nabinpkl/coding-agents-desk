import AppKit
import CryptoKit
import Foundation
import Network
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
    private let tailnetDiscovery = TailscaleStatusDiscovery()
    private let launchAgentLogger = Logger(subsystem: Config.launchAgentLabel, category: "launchAgent")
    private let signalingLogger = Logger(subsystem: Config.launchAgentLabel, category: "signaling")
    private var signalingServer: PairingSignalingServer?
    private let sessions = SessionRegistry()
    private let scrollActivityHints = ScrollActivityStore()
    private let inputDispatcher = InputDispatcher()
    private let spacesProvider = SpacesProvider()
    private let spaceThumbnailProvider = SpaceThumbnailProvider()
    private let cursorMonitor = CursorMonitor()
    private var spaceAgentController: SpaceAgentController?
    private var dictationBarController: DictationBarController?
    private var terminalLauncherController: TerminalLauncherController?
    private var gesturePortalController: GesturePortalController?
    private var gestureChildController: GestureChildController?
    private var voiceChildController: VoiceChildController?
    private var agentSayServer: AgentSayLocalServer?
    private var thumbnailsBroadcastTask: Task<Void, Never>?
    private var thumbnailEnabledClients: Set<DeviceFingerprint> = []
    private let frameSource: VideoFrameSource = MediaStack.makeFrameSource()
    private var pairingSignalSource: DispatchSourceSignal?
    // ADR-0019: bounds the .pairingOffered state so a device that never dials
    // back does not strand the popover. Cancelled when the device starts
    // connecting or the user leaves the offered state.
    private var pairingOfferTimeoutTask: Task<Void, Never>?

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
        installCursorMonitor()
        startAgentSayServer()
        startSpaceAgent()
        startVoiceChildIfConfigured()
        startDictationBar()
        startTerminalLauncher()
        startGesturePortalIfConfigured()
        startGestureChildIfConfigured()
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
        dictationBarController?.stop()
        terminalLauncherController?.stop()
        voiceChildController?.stop()
        agentSayServer?.stop()
        signalingServer?.stop()
    }

    private func configureStatusItem() {
        applyIcon(.idle)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
    }

    private func startAgentSayServer() {
        let server = AgentSayLocalServer { [weak self] push in
            guard let self else { return false }
            let inputServers = self.sessions.allInputChannelServers()
            guard !inputServers.isEmpty else { return false }
            for inputServer in inputServers {
                inputServer.pushAgentSay(push)
            }
            return true
        }
        agentSayServer = server
        server.start()
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
        popover.contentSize = NSSize(width: 300, height: 380)
        popover.contentViewController = popoverController
        popoverController.onStartPairing = { [weak self] in
            self?.showDevicePicker()
        }
        popoverController.onPairDevice = { [weak self] device in
            self?.pairWithDevice(device)
        }
        popoverController.onRevoke = { [weak self] fingerprint in
            self?.revokeDevice(fingerprint)
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
        popoverController.onQuit = {
            self.gestureChildController?.stop()
            self.gesturePortalController?.stop()
            self.voiceChildController?.stop()
            NSApp.terminate(nil)
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
            sessionReadyHandler: { [weak self] active, ready, datagrams, mediaKey in
                Task { @MainActor in
                    self?.handleSessionReady(active, ready: ready, datagrams: datagrams, mediaKey: mediaKey)
                }
            },
            sessionResumeHandler: { [weak self] request in
                try await MainActor.run {
                    guard let self else { throw SessionRejected(reason: .unauthorized) }
                    return try self.handleSessionResume(request)
                }
            },
            sessionSuspendedHandler: { [weak self] fingerprint, sessionId in
                Task { @MainActor in
                    self?.handleSessionSuspended(fingerprint, sessionId: sessionId)
                }
            },
            sessionEndedHandler: { [weak self] fingerprint, sessionId in
                Task { @MainActor in
                    self?.handleSessionEnded(fingerprint, sessionId: sessionId)
                }
            },
            inputLaneReadyHandler: { [weak self] fingerprint, server in
                Task { @MainActor in
                    self?.handleInputLaneReady(fingerprint, server: server)
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
        // The offered device dialed back; the offer wait is over.
        pairingOfferTimeoutTask?.cancel()
        pairingOfferTimeoutTask = nil
        sessions.noteAttempt(fingerprint)
        signalingLogger.notice("session attempt started fingerprint=\(fingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func handleSessionReady(
        _ active: ActiveSession,
        ready: SessionReady,
        datagrams: QUIC.Datagrams<QUICDatagram>,
        mediaKey: SymmetricKey
    ) {
        let transport = QuicSessionHostMediaTransport(
            source: frameSource,
            datagrams: datagrams,
            mediaKey: mediaKey
        )
        sessions.noteReady(active, ready: ready, transport: transport)
        signalingLogger.notice("session ready fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public) session=\(active.sessionId, privacy: .public)")
        startMediaTransport(transport, for: active)
        refreshConnectedState()
    }

    private func handleSessionResume(_ request: SessionResumeInit) throws -> (ActiveSession, SessionReady) {
        switch sessions.validateResume(request) {
        case .accepted(let active):
            guard (try? pairing.lookup(deviceFingerprint: active.deviceFingerprint)) != nil else {
                throw SessionRejected(reason: .unknownDevice)
            }
            let ready = try sessions.makeResumeReady(for: active.deviceFingerprint)
            signalingLogger.notice("session resuming fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public) session=\(active.sessionId, privacy: .public)")
            return (active, ready)
        case .rejected(let reason):
            throw SessionRejected(reason: reason)
        }
    }

    private func handleSessionSuspended(_ fingerprint: DeviceFingerprint, sessionId: String?) {
        sessions.markSuspended(fingerprint, sessionId: sessionId)
        signalingLogger.notice("session suspended fingerprint=\(fingerprint.rawValue, privacy: .public)")
        let graceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Config.sessionResumeTTL * 1_000_000_000))
            await MainActor.run { [weak self] in
                guard let self,
                      self.sessions.state(for: fingerprint) == .suspended else { return }
                self.handleSessionEnded(fingerprint, sessionId: sessionId)
            }
        }
        sessions.scheduleResumeGrace(graceTask, for: fingerprint)
        refreshConnectedState()
    }

    private func handleSessionEnded(
        _ fingerprint: DeviceFingerprint,
        sessionId: String? = nil,
        closeSignaling: Bool = false
    ) {
        thumbnailEnabledClients.remove(fingerprint)
        spaceThumbnailProvider.setDemand(owner: .client(fingerprint.rawValue), enabled: false)
        sessions.endSession(fingerprint, sessionId: sessionId)
        signalingLogger.notice("session ended fingerprint=\(fingerprint.rawValue, privacy: .public)")
        refreshConnectedState()
    }

    private func startMediaTransport(_ transport: MediaTransport, for active: ActiveSession) {
        let fingerprint = active.deviceFingerprint

        Task { [weak self, transport] in
            for await state in transport.connectionState {
                await self?.handleMediaConnectionState(state, for: fingerprint)
            }
        }

        Task { [signalingLogger, transport] in
            do {
                try await transport.start(
                    videoSource: nil,
                    videoSink: nil
                )
                signalingLogger.notice("media transport started")
            } catch {
                signalingLogger.error("media transport start failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // ADR-0030: the client opened the input stream inside the session QUIC
    // connection. Off-MainActor like the previous data-channel-input task
    // because the dispatcher owns its serial queue, so CGEvent.post never
    // serialises behind UI work.
    private func handleInputLaneReady(_ fingerprint: DeviceFingerprint, server: InputChannelServer) {
        signalingLogger.notice("input lane ready fp=\(fingerprint.rawValue, privacy: .public)")
        sessions.attachInputChannelServer(server, for: fingerprint)
        // R11: push the current DesktopState as soon as the channel is
        // attached so the client can render the dots band immediately
        // on session start without waiting for a Spaces switch.
        if let state = spacesProvider.current() {
            server.pushDesktopState(state)
        }
        // Seed the cursor overlay with the current cursor image so the
        // client renders the right glyph immediately, without waiting for
        // the next shape change.
        if let cursor = cursorMonitor.latest {
            server.pushCursor(cursor)
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
        let scrollActivityHints = scrollActivityHints
        let logger = signalingLogger
	        sessions.attachInputTask(
	            Task { [server, dispatcher, scrollActivityHints, logger] in
	                for await input in server.events {
	                    scrollActivityHints.record(input)
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
                let topWindows = provider.latestTopWindows
                for (fingerprint, server) in registry.allInputChannelServersByFingerprint()
                    where enabledClients.contains(fingerprint) {
                    server.pushThumbnails(thumbnails, topWindows: topWindows)
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

    private func startDictationBar() {
        let transcriber = TranscriptionClient(voiceChild: voiceChildController)
        let controller = DictationBarController(
            transcriber: transcriber,
            typeText: { [inputDispatcher] text in inputDispatcher.typeText(text) }
        )
        // Set the handle-frame provider before start() so the bar's first
        // placement already dodges the SpaceAgent handle (started just above).
        controller.spaceAgentHandleFrame = { [weak self] in
            self?.spaceAgentController?.currentHandleScreenFrame()
        }
        dictationBarController = controller
        controller.start()
        // And keep dodging as the handle is dragged or the popover resizes. A
        // handle move re-dodges both sibling overlays.
        spaceAgentController?.onHandleFrameDidChange = { [weak self] in
            self?.dictationBarController?.keepClearOfSpaceAgentHandle()
            self?.terminalLauncherController?.keepClearOfNeighbors()
            self?.gesturePortalController?.keepClearOfNeighbors()
        }
        // A dictation-bar move re-dodges the terminal pill (its other neighbor).
        controller.onFrameDidChange = { [weak self] in
            self?.terminalLauncherController?.keepClearOfNeighbors()
            self?.gesturePortalController?.keepClearOfNeighbors()
        }
    }

    private func startVoiceChildIfConfigured() {
        guard let executableURL = Config.voiceChildExecutableURL else { return }
        let controller = VoiceChildController(
            executableURL: executableURL,
            arguments: Config.voiceChildArguments,
            model: Config.transcriptionModel
        )
        voiceChildController = controller
        controller.start()
    }

    private func startTerminalLauncher() {
        let controller = TerminalLauncherController()
        controller.spaceAgentHandleFrame = { [weak self] in
            self?.spaceAgentController?.currentHandleScreenFrame()
        }
        controller.dictationBarFrame = { [weak self] in
            self?.dictationBarController?.currentScreenFrame()
        }
        terminalLauncherController = controller
        controller.start()
    }

    private func startGesturePortalIfConfigured() {
        // The portal is the gesture child's on-screen surface; with no child
        // configured there is nothing to drive it, so do not show the panel.
        guard Config.gestureChildExecutableURL != nil else { return }
        let controller = GesturePortalController()
        controller.spaceAgentHandleFrame = { [weak self] in
            self?.spaceAgentController?.currentHandleScreenFrame()
        }
        controller.dictationBarFrame = { [weak self] in
            self?.dictationBarController?.currentScreenFrame()
        }
        controller.terminalLauncherFrame = { [weak self] in
            self?.terminalLauncherController?.currentScreenFrame()
        }
        gesturePortalController = controller
        controller.start()
    }

    private func startGestureChildIfConfigured() {
        guard let executableURL = Config.gestureChildExecutableURL else { return }
        let controller = GestureChildController(
            executableURL: executableURL,
            arguments: Config.gestureChildArguments,
            onGestureState: { [weak self] state in
                self?.gesturePortalController?.update(state)
            },
            commitStep: { [spacesProvider] delta in
                spacesProvider.commitStep(delta: delta)
            }
        )
        gestureChildController = controller
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

    // Cursor mirror: CursorMonitor polls NSCursor.currentSystem and emits
    // a CursorImagePush on every shape change. Broadcast each change to all
    // attached clients. Runs for the process lifetime; a fresh client is
    // separately seeded with `cursorMonitor.latest` on attach.
    private func installCursorMonitor() {
        let registry = sessions
        cursorMonitor.onChange = { [weak registry] push in
            guard let registry else { return }
            for server in registry.allInputChannelServers() {
                server.pushCursor(push)
            }
        }
        cursorMonitor.start()
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
            break
        case .disconnected:
            sessions.markSuspended(fingerprint)
        case .failed, .closed:
            handleSessionEnded(fingerprint)
        }
    }

    private func revokeDevice(_ fingerprint: DeviceFingerprint) {
        try? pairing.revoke(deviceFingerprint: fingerprint)
        handleSessionEnded(fingerprint, closeSignaling: true)
        refreshConnectedState()
    }

    // ADR-0019: the menubar "Pair iPhone" button enumerates tailnet peers and
    // shows the device picker. Picking a device is the host-side authorization.
    // QR pairing stays reachable via SIGUSR1 -> startPairing.
    private func showDevicePicker() {
        // Leaving any in-flight offer (the user came back to pick again).
        pairingOfferTimeoutTask?.cancel()
        pairingOfferTimeoutTask = nil
        let candidates: [TailnetDeviceOption]
        do {
            // ADR-0019: probe online iOS peers and list only those that identify
            // themselves, so the picker shows real AgentDesk clients by name
            // (no storage, no tailnet "localhost").
            candidates = try tailnetDiscovery.peerDevices().filter { $0.isIOS && $0.online }
        } catch is TailscaleRequiredError {
            signalingLogger.error("device picker failed: tailscale required")
            applyIcon(.tailscaleRequired)
            popoverController.render(.tailscaleRequired)
            return
        } catch {
            signalingLogger.error("device picker failed: \(String(describing: error), privacy: .public)")
            applyIcon(.pairingFailed)
            popoverController.render(.idle)
            return
        }

        applyIcon(.pairing)
        popoverController.render(.scanning)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let prober = TailnetIdentityProber()
            let responders = await withTaskGroup(of: TailnetDeviceOption?.self) { group in
                for peer in candidates {
                    group.addTask {
                        guard let identity = await prober.identify(ipv4: peer.ipv4) else {
                            return nil
                        }
                        return TailnetDeviceOption(
                            hostname: identity.displayName,
                            os: peer.os,
                            ipv4: peer.ipv4,
                            online: true
                        )
                    }
                }
                var found: [TailnetDeviceOption] = []
                for await result in group where result != nil {
                    found.append(result!)
                }
                return found
            }
            let sorted = responders.sorted {
                $0.hostname.localizedCaseInsensitiveCompare($1.hostname) == .orderedAscending
            }
            self.popoverController.render(.devicePicker(sorted))
        }
    }

    // ADR-0019: mint an offer, pre-approve its nonce tagged with the picked
    // device name (the pick is the authorization), and push it to the chosen
    // device over the tailnet. The iPhone runs the unchanged handshake and the
    // host auto-approves, recording the device name so the popover shows it.
    private func pairWithDevice(_ device: TailnetDeviceOption) {
        let ipv4 = device.ipv4
        do {
            let payload = try pairing.mintPairingPayload()
            pairing.markPreApproved(nonce: payload.oneTimeNonce, name: device.hostname)
            applyIcon(.pairing)
            popoverController.render(.pairingOffered(device.hostname))
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await PairingOfferSender().send(offer: payload, toIPv4: ipv4)
                    self.signalingLogger.notice("pairing offer pushed to \(ipv4, privacy: .public)")
                } catch {
                    self.signalingLogger.error("pairing offer send failed: \(String(describing: error), privacy: .public)")
                    self.showDevicePicker()
                }
            }
            // Bound the wait: if the device never dials back, return to the
            // picker so the user can retry instead of being stranded. Cancelled
            // in handleSessionAttemptStarted once the device responds.
            pairingOfferTimeoutTask?.cancel()
            pairingOfferTimeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, !Task.isCancelled else { return }
                self.signalingLogger.notice("pairing offer timed out; returning to picker")
                self.showDevicePicker()
            }
        } catch is TailscaleRequiredError {
            applyIcon(.tailscaleRequired)
            popoverController.render(.tailscaleRequired)
        } catch {
            signalingLogger.error("pairWithDevice failed: \(String(describing: error), privacy: .public)")
            applyIcon(.pairingFailed)
            popoverController.render(.idle)
        }
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
        let approved = (try? pairing.approvedDevices()) ?? []
        guard !approved.isEmpty else {
            applyIcon(.idle)
            popoverController.render(.idle)
            return
        }
        // More than one device can be paired (a client reinstall mints a fresh
        // device key and therefore a new record), so pick the device whose
        // session is actually live instead of assuming a single record. Without
        // this, the popover shows a stale record as "not connected" while the
        // real device is streaming.
        if let active = approved.first(where: { sessions.isActive($0.deviceFingerprint) }) {
            applyIcon(.connected)
            popoverController.render(.connected(active))
        } else if let attempting = approved.first(where: { sessions.isAttempting($0.deviceFingerprint) }) {
            applyIcon(.connecting)
            popoverController.render(.connecting(attempting))
        } else {
            let record = approved.max(by: { $0.approvedAt < $1.approvedAt }) ?? approved[0]
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
