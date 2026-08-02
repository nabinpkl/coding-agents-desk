import AppKit
import Carbon
import CryptoKit
import Foundation
import Network
import os
import AgentDeskWire
import BrowserProjection
import TerminalEmulator

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
    private let launchAgentLogger = Logger(subsystem: Config.logSubsystem, category: "launchAgent")
    private let signalingLogger = Logger(subsystem: Config.logSubsystem, category: "signaling")
    private let diagnosticsLogger = Logger(subsystem: Config.logSubsystem, category: "client-diagnostics")
    private let thumbnailsLogger = Logger(subsystem: Config.logSubsystem, category: "thumbnails")
    private var signalingServer: PairingSignalingServer?
    private let sessions = SessionRegistry()
    private let scrollActivityHints = ScrollActivityStore()
    private let displaySelection = DisplaySelectionStore()
    private var hostAvailability = HostAvailabilityController()
    private lazy var inputDispatcher = InputDispatcher(
        displayBoundsProvider: { [displaySelection] in
            displaySelection.selectedBounds()
        },
        selectedDisplayIdProvider: { [displaySelection] in
            displaySelection.selectedDisplayId
        }
    )
    private lazy var spacesProvider = SpacesProvider(
        selectedDisplayIdProvider: { [displaySelection] in
            displaySelection.selectedDisplayId
        }
    )
    private let spaceThumbnailProvider = SpaceThumbnailProvider()
    private let cursorMonitor = CursorMonitor()
    private let textInputFocusProbeCoordinator = HostTextInputFocusProbeCoordinator()
    private var spaceAgentController: SpaceAgentController?
    private var dictationBarController: DictationBarController?
    private var ptyRuntimeProcess: HostPtyRuntimeProcess?
    private lazy var terminalWindowRegistry = TerminalWindowRegistry()
    private var terminalClientBridges: [ObjectIdentifier: TerminalClientBridge] = [:]
    // Protocol-v11 workspace lane. One responder serializes file writes against the workspace
    // store. Each attached `.files` stream owns a subscription session, while the repository
    // imports the donor store once on first load.
    private var workspaceLanes: [ObjectIdentifier: WorkspaceLaneServer] = [:]
    private var workspaceLaneSessions: [ObjectIdentifier: WorkspaceLaneSession] = [:]
    private let workspaceRepository = WorkspaceRepository(
        donorURL: Config.donorWorkspaceStoreURL,
        destinationURL: Config.workspaceStoreURL
    )
    private lazy var workspaceCoordinator = WorkspaceCoordinator(repository: workspaceRepository)
    private lazy var workspaceIDEStateCoordinator = WorkspaceIDEStateCoordinator(
        storeURL: Config.workspaceIDEStateURL
    )
    private lazy var workspaceObservationCoordinator = WorkspaceObservationCoordinator()
    private lazy var workspaceFilesResponder = WorkspaceFilesResponder(
        workspaceCoordinator: workspaceCoordinator,
        maxUTF8Bytes: Config.workspaceFileMaxBytes,
        maxDocumentBytes: Config.workspaceDocumentMaxBytes
    )
    private var workspaceShellPresenter: WorkspaceShellPresenter?
    private var workspaceIDEWindowController: WorkspaceIDEWindowController?
    private var browserProjectionWindowController: BrowserProjectionWindowController?
    private var browserProjectionSession: BrowserProjectionSession?
    private var browserProjectionLane: BrowserProjectionLocalLane?
    private var browserProjectionViewportCoordinator: BrowserProjectionViewportCoordinator?
    // Independent macOS Agents windows, created from the shell's top-bar "＋ Agents" command. Each
    // window owns its feed visibility subscription and local terminal endpoint.
    private var agentWindowRegistry: AgentWindowRegistry?
    private var agentWindowTerminationTask: Task<Void, Never>?
    // The macOS gesture window: the shared InteractionPanel webview runs camera +
    // the TS swipe tracker and applies each Space step in-process. Opt-in via
    // AGENTDESK_GESTURE_WINDOW_ENABLED until a top-bar toggle is added.
    private var gestureWindowController: GestureWindowController?
    private var agentSayServer: AgentSayLocalServer?
    private var thumbnailsBroadcastTask: Task<Void, Never>?
    private var thumbnailEnabledClients: Set<DeviceFingerprint> = []
    private var textInputFocusProbeGate = HostTextInputFocusProbeGate()
    private lazy var frameSource: VideoFrameSource = MediaStack.makeFrameSource(
        selectedDisplayIdProvider: { [displaySelection] in
            displaySelection.selectedDisplayId
        }
    )
    private var pairingSignalSource: DispatchSourceSignal?
    private var diagnosticsSignalSource: DispatchSourceSignal?
    private lazy var diagnosticsRequester = ClientDiagnosticsRequester(
        sessions: sessions,
        pairing: pairing,
        tailnetDiscovery: tailnetDiscovery
    )
    private lazy var clientTelemetryStore = HostClientTelemetryStore()
    private lazy var screenshotRequester = ClientScreenshotRequester(
        sessions: sessions,
        pairing: pairing,
        tailnetDiscovery: tailnetDiscovery
    )
    private lazy var clientDebugAutomationController = ClientDebugAutomationController(
        diagnosticsRequester: diagnosticsRequester,
        screenshotRequester: screenshotRequester
    )
    // Agent feed sidecar: owns transcript discovery and exposes its loopback API.
    private lazy var agentFeedSidecar: AgentFeedSidecarProcess? = {
        guard let binaryURL = Config.agentFeedSidecarURL else {
            launchAgentLogger.error("agent sidecar binary not found in bundle")
            return nil
        }
        return AgentFeedSidecarProcess(
            binaryURL: binaryURL,
            port: Config.agentFeedSidecarPort
        )
    }()
    // Voice server sidecar: spawns `voice-server` on loopback for the
    // InteractionPanel's voice UI (live capture + transcript). Built in
    // startVoiceEngineSidecar() after the venv is provisioned (or from the
    // env-driven dev launch), so it is a plain var rather than a lazy resolved
    // before provisioning completes.
    private var voiceEngineSidecar: VoiceEngineSidecar?
    // Bridge between the sidecar and the active session's input lane.
    private var agentFeedBridge: AgentFeedBridge?
    private lazy var agentSessionTerminalCoordinator: AgentSessionTerminalCoordinator = {
        let sidecar = agentFeedSidecar
        return AgentSessionTerminalCoordinator(
            ptyClient: PtyClientAgentSessionTerminalAdapter(
                client: PtyManagerSocketClient.makeClient()
            ),
            livenessChecker: SidecarAgentSessionTerminalLivenessChecker(
                client: HttpSidecarClient(baseURLProvider: { [weak sidecar] in sidecar?.baseURL })
            ),
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            executables: Config.agentResumeExecutables,
            requestTombstoneLimit: Config.agentTerminalRequestTombstoneLimit,
            waitForHandoffTimeout: {
                try await Task.sleep(for: .seconds(Config.agentTerminalHandoffTimeoutSeconds))
            },
            onEvent: { [weak self] event in
                Task { @MainActor in
                    await self?.routeAgentSessionTerminalEvent(event)
                }
            }
        )
    }()
    private lazy var agentSessionTerminalEndpoints = AgentSessionTerminalEndpointRegistry<DeviceFingerprint> {
        [unowned self] fingerprint, epoch in
        AgentSessionTerminalEndpoint(
            coordinator: agentSessionTerminalCoordinator,
            platform: .iOS,
            requestNamespace: "ios-\(fingerprint.rawValue)-\(epoch)",
            tombstoneLimit: Config.agentTerminalRequestTombstoneLimit
        )
    }
    private lazy var workspaceTerminalCoordinator = WorkspaceTerminalCoordinator(
        workspaceCoordinator: workspaceCoordinator,
        ptyClient: PtyClientAgentSessionTerminalAdapter(
            client: PtyManagerSocketClient.makeClient()
        ),
        shell: Config.workspaceTerminalShell,
        requestTombstoneLimit: Config.agentTerminalRequestTombstoneLimit,
        waitForHandoffTimeout: {
            try await Task.sleep(for: .seconds(Config.workspaceTerminalHandoffTimeoutSeconds))
        },
        onEvent: { [weak self] event in
            Task { @MainActor in
                await self?.routeWorkspaceTerminalEvent(event)
            }
        }
    )
    private lazy var workspaceTerminalEndpoints = TerminalEndpointRegistry<
        DeviceFingerprint,
        WorkspaceTerminalEndpoint
    > { [unowned self] fingerprint, epoch in
        WorkspaceTerminalEndpoint(
            coordinator: workspaceTerminalCoordinator,
            requestNamespace: "workspace-ios-\(fingerprint.rawValue)-\(epoch)",
            clientTitle: "workspace-terminal-bootstrap-ios",
            tombstoneLimit: Config.agentTerminalRequestTombstoneLimit,
            push: nil
        )
    }
    private var localWorkspaceTerminalEndpoint: WorkspaceTerminalEndpoint?
    // ADR-0038 DOM mirror: the Chrome-fed native-messaging bridge server and the relay that buffers
    // checkouts and fans rrweb batches to the attached client .dom lane. Constructed and started
    // only when Config.domMirrorEnabled; otherwise the whole subsystem stays dark.
    private var domBridgeServer: DomBridgeServer?
    private let domMirrorRelay = DomMirrorRelay()
    // ADR-0019: bounds the .pairingOffered state so a device that never dials
    // back does not strand the popover. Cancelled when the device starts
    // connecting or the user leaves the offered state.
    private var pairingOfferTimeoutTask: Task<Void, Never>?
    // ADR-0049: durable pre-arm intents (devices picked while their app was
    // closed), the readiness poll per pre-armed IPv4, and the name shown in the
    // waiting popover. A pre-arm survives the phone being closed and a host
    // restart; the poll fires the existing offer push once the app answers whois.
    private let preArmStore = PreArmedTargetStore()
    private var preArmPollTasks: [String: Task<Void, Never>] = [:]
    private var activePreArmName: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Config.axAutomationEnabled {
            promoteToForegroundApplicationForAXAutomation()
            NSApp.setActivationPolicy(.regular)
        } else {
            NSApp.setActivationPolicy(.accessory)
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // A dev iteration run (`just host-run`) is a transient, env-carrying
        // launch, not a production login install. Registering the LaunchAgent here
        // could make launchd RunAtLoad a second, env-less copy. Skip it for dev
        // runs; the daily-driver launch still installs it.
        if !Config.devIterationRun {
            installLaunchAgent()
        }
        configureStatusItem()
        configurePopover()
        bootstrapTLSIdentity()
        installAutomationSignalHandlers()
        startSignalingServer()
        bootstrapDefaultWorkspaceIfConfigured()
        startWorkspaceShellIfEnabled()
        startDomMirrorIfEnabled()
        refreshConnectedState()
        resumePreArms()
        installSpacesSwitchHandler()
        installSpacesChangeObserver()
        installLockAvailabilityObserver()
        installThumbnailsBroadcast()
        installCursorPositionMonitor()
        installCursorMonitor()
        startAgentSayServer()
        startSpaceAgent()
        startDictationBar()
        startPtyManager()
        startAgentFeedSidecar()
        startVoiceEngineSidecar()
        restoreWorkspaceIDEWindowIfPreviouslyOpen()
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

    private func promoteToForegroundApplicationForAXAutomation() {
        var processSerialNumber = ProcessSerialNumber(
            highLongOfPSN: 0,
            lowLongOfPSN: UInt32(kCurrentProcess)
        )
        TransformProcessType(
            &processSerialNumber,
            ProcessApplicationTransformState(kProcessTransformToForegroundApplication)
        )
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
    // mint a fresh URL without a menubar click. SIGUSR2 runs an on-demand
    // client debug artifact collection described in ADR-0032 and ADR-0070.
    // Both signals are local-uid-only and mirror the trust model of the
    // menubar actions.
    private func installAutomationSignalHandlers() {
        signal(SIGUSR1, SIG_IGN)
        signal(SIGUSR2, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in
            self?.signalingLogger.notice("SIGUSR1 received; starting pairing")
            self?.startPairing(writeAutomationURL: true)
        }
        source.resume()
        pairingSignalSource = source

        let diagnostics = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        diagnostics.setEventHandler { [weak self] in
            guard let self else { return }
            self.diagnosticsLogger.notice("SIGUSR2 received; collecting requested client debug artifacts")
            Task { @MainActor in
                await self.clientDebugAutomationController.handleRequestFromDisk()
            }
        }
        diagnostics.resume()
        diagnosticsSignalSource = diagnostics
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let registry = agentWindowRegistry, registry.requiresTerminationWait else {
            return .terminateNow
        }
        guard agentWindowTerminationTask == nil else { return .terminateLater }
        let stopTask = registry.beginStopAll()
        agentWindowTerminationTask = Task { @MainActor [weak self, weak sender] in
            await stopTask.value
            if self?.agentWindowRegistry === registry {
                self?.agentWindowRegistry = nil
            }
            sender?.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        textInputFocusProbeCoordinator.cancelAll()
        spaceAgentController?.stop()
        dictationBarController?.stop()
        for bridge in terminalClientBridges.values {
            bridge.stop()
        }
        terminalClientBridges.removeAll()
        for lane in workspaceLanes.values {
            lane.stop()
        }
        for session in workspaceLaneSessions.values {
            Task { await session.stop() }
        }
        workspaceLanes.removeAll()
        workspaceLaneSessions.removeAll()
        workspaceIDEWindowController?.stop()
        workspaceIDEWindowController = nil
        browserProjectionWindowController?.stop()
        browserProjectionWindowController = nil
        browserProjectionLane?.close()
        browserProjectionLane = nil
        browserProjectionSession = nil
        browserProjectionViewportCoordinator = nil
        workspaceObservationCoordinator.stop()
        workspaceShellPresenter?.stop()
        workspaceShellPresenter = nil
        terminalWindowRegistry.prepareForHostTermination()
        // Normal termination waits for this in applicationShouldTerminate. This fallback still
        // establishes the close barrier if AppKit reaches willTerminate without that callback.
        agentWindowRegistry?.beginStopAll()
        agentWindowRegistry = nil
        gestureWindowController?.stop()
        gestureWindowController = nil
        agentSayServer?.stop()
        signalingServer?.stop()
        agentFeedSidecar?.stop()
        voiceEngineSidecar?.stop()
    }

    private func configureStatusItem() {
        applyIcon(.idle)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
    }

    private func startAgentFeedSidecar() {
        agentFeedSidecar?.start()
    }

    private func startVoiceEngineSidecar() {
        // Prefer the shipped provisioned venv; fall back to the env-driven dev
        // launch. Provisioning is off-main and can take a while on first launch,
        // so the sidecar is constructed and started from its completion.
        if let inputs = Config.voiceProvisionerInputs {
            let provisioner = VoiceVenvProvisioner(inputs: inputs)
            provisioner.ensureProvisioned { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .success(let voiceServer):
                        self.startVoiceSidecar(
                            launch: Config.provisionedVoiceLaunch(
                                voiceServerExecutable: voiceServer
                            )
                        )
                    case .failure:
                        // Provisioning failed loud in the provisioner's log; try
                        // the dev launch so a configured checkout still works.
                        self.startVoiceSidecarFromDevLaunch()
                    }
                }
            }
            return
        }
        startVoiceSidecarFromDevLaunch()
    }

    private func startVoiceSidecarFromDevLaunch() {
        guard let launch = Config.voiceSidecarLaunch else {
            launchAgentLogger.notice("voice sidecar launch not configured; voice UI will be offline")
            return
        }
        startVoiceSidecar(launch: launch)
    }

    private func startVoiceSidecar(launch: VoiceSidecarLaunch) {
        // Guard against a double-start if provisioning and a fallback ever race.
        guard voiceEngineSidecar == nil else { return }
        let sidecar = VoiceEngineSidecar(launch: launch, port: Config.voiceSidecarPort)
        voiceEngineSidecar = sidecar
        sidecar.start()
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
        popoverController.onCancelPreArm = { [weak self] in
            self?.cancelPreArms()
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
        popoverController.onRequestRemoteDesktop = {
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_RemoteDesktop") {
                NSWorkspace.shared.open(url)
            }
        }
        popoverController.onQuit = {
            NSApp.terminate(nil)
        }
    }

    private func startWorkspaceShellIfEnabled() {
        guard Config.workspaceShellEnabled else { return }
        let presenter = WorkspaceShellPresenter(
            workspaceCoordinator: workspaceCoordinator,
            observationCoordinator: workspaceObservationCoordinator,
            spacesProvider: spacesProvider,
            terminalWindowRegistry: terminalWindowRegistry
        )
        workspaceShellPresenter = presenter

        // Each top-bar command creates an independent Agents window on the current Desktop. Every
        // window resolves the sidecar base URL lazily and owns a distinct terminal endpoint, so feed
        // visibility and terminal pushes cannot overwrite another window's subscription.
        let sidecar = agentFeedSidecar
        let agentWindows = AgentWindowRegistry(
            store: AgentWindowPresentationStore(url: Config.agentWindowPresentationsURL),
            sidecarClient: HttpSidecarClient(baseURLProvider: { [weak sidecar] in sidecar?.baseURL }),
            terminalCoordinator: agentSessionTerminalCoordinator,
            terminalTombstoneLimit: Config.agentTerminalRequestTombstoneLimit,
            makeTerminalPtyClient: { PtyManagerSocketClient.makeClient() }
        )
        agentWindowRegistry = agentWindows
        presenter.onOpenAgents = { [weak agentWindows] placement in
            agentWindows?.open(placement)
        }
        // Put back the Agents windows the user was working in. Same launch contract as the IDE
        // window: reopened where they were left, without taking focus from whatever is frontmost.
        agentWindows.startRestoration()
        presenter.onIDECommand = { [weak self] in self?.toggleWorkspaceIDE() }
        presenter.onBrowserCommand = { [weak self] in self?.toggleBrowserProjection() }

        // Gesture window: the InteractionPanel webview detects swipes and steps
        // Spaces via the same commitStep path the QUIC input lane uses. Toggled
        // from the top-bar "Gesture" button.
        let gestureWindow = GestureWindowController(onSpaceStep: { [weak self] delta in
            self?.spacesProvider.commitStep(delta: delta)
        })
        gestureWindowController = gestureWindow
        presenter.onGestureCommand = { [weak gestureWindow] in gestureWindow?.toggle() }

        presenter.show()
    }

    private func toggleWorkspaceIDE() {
        workspaceIDEWindow().toggle()
    }

    /// Puts the IDE back on screen if that is where the user left it. Called at launch so a host
    /// restart does not cost them the window they were working in; when it was closed we build
    /// nothing, and the controller stays lazy until they ask for it.
    private func restoreWorkspaceIDEWindowIfPreviouslyOpen() {
        guard WorkspaceIDEWindowController.wasVisibleAtLastQuit else { return }
        workspaceIDEWindow().show(activating: false)
    }

    private func workspaceIDEWindow() -> WorkspaceIDEWindowController {
        if let workspaceIDEWindowController { return workspaceIDEWindowController }
        let terminalEndpoint = localWorkspaceTerminalEndpoint ?? WorkspaceTerminalEndpoint(
            coordinator: workspaceTerminalCoordinator,
            requestNamespace: "workspace-macos-ide",
            clientTitle: "workspace-terminal-bootstrap-macos-ide",
            tombstoneLimit: Config.agentTerminalRequestTombstoneLimit,
            push: nil
        )
        localWorkspaceTerminalEndpoint = terminalEndpoint
        let controller = WorkspaceIDEWindowController(
            files: workspaceFilesResponder,
            workspaces: workspaceCoordinator,
            ideState: workspaceIDEStateCoordinator,
            observation: workspaceObservationCoordinator,
            terminalEndpoint: terminalEndpoint,
            spacesProvider: spacesProvider
        )
        workspaceIDEWindowController = controller
        return controller
    }

    private func toggleBrowserProjection() {
        guard let browserProjectionSession else { return }
        let controller = browserProjectionWindowController ?? BrowserProjectionWindowController()
        if browserProjectionWindowController == nil {
            browserProjectionWindowController = controller
            browserProjectionSession.attach(controller)
        }
        controller.toggle()
    }

    private func bootstrapDefaultWorkspaceIfConfigured() {
        guard let root = Config.defaultWorkspaceRoot else { return }
        Task { [workspaceCoordinator, signalingLogger] in
            do {
                let store = try await workspaceCoordinator.snapshot()
                guard store.workspaces.isEmpty else { return } // never override an existing store
                _ = try await workspaceCoordinator.apply(.register(
                    id: UUID(),
                    root: root,
                    name: root.lastPathComponent
                ))
                signalingLogger.notice("registered default workspace at \(root.path, privacy: .public)")
            } catch {
                signalingLogger.error("default workspace bootstrap failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func startSignalingServer() {
        signalingServer = PairingSignalingServer(
            pairing: pairing,
            approvalHandler: { [weak self] fingerprint, completion in
                Task { @MainActor in
                    self?.showApprovalSheet(for: fingerprint, completion: completion)
                }
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
            sessionResumeChallengeHandler: { [weak self] request in
                try await MainActor.run {
                    guard let self else { throw SessionRejected(reason: .unauthorized) }
                    return try self.handleSessionResumeChallenge(request)
                }
            },
            sessionResumeChallengeCancelledHandler: { [weak self] request in
                await MainActor.run {
                    self?.sessions.cancelResumeChallenge(request)
                }
            },
            sessionResumeHandler: { [weak self] request, proof in
                try await MainActor.run {
                    guard let self else { throw SessionRejected(reason: .unauthorized) }
                    return try self.handleSessionResume(request, proof: proof)
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
            },
            graphicsLaneReadyHandler: { [weak self] fingerprint, lane in
                Task { @MainActor in
                    self?.handleGraphicsLaneReady(fingerprint, lane: lane)
                }
            },
            domLaneReadyHandler: { [weak self] fingerprint, lane in
                Task { @MainActor in
                    self?.handleDomLaneReady(fingerprint, lane: lane)
                }
            },
            terminalLaneReadyHandler: { [weak self] fingerprint, bridge in
                Task { @MainActor in
                    self?.handleTerminalLaneReady(fingerprint, bridge: bridge)
                }
            },
            workspaceLaneReadyHandler: { [weak self] fingerprint, lane in
                Task { @MainActor in
                    self?.handleWorkspaceLaneReady(fingerprint, lane: lane)
                }
            },
            voiceLaneReadyHandler: { [weak self] fingerprint, lane in
                Task { @MainActor in
                    self?.handleVoiceLaneReady(fingerprint, lane: lane)
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
        let fingerprint = active.deviceFingerprint
        let sessionId = active.sessionId
        let transport = QuicSessionHostMediaTransport(
            source: frameSource,
            datagrams: datagrams,
            mediaKey: mediaKey,
            onFirstFrameSent: { [weak self] frameId in
                Task { @MainActor [weak self] in
                    self?.clientTelemetryStore.record(
                        .firstFrameSent,
                        fingerprint: fingerprint,
                        sessionId: sessionId,
                        frameId: frameId
                    )
                }
            },
            onFirstFrameAcknowledged: { [weak self] frameId in
                Task { @MainActor [weak self] in
                    self?.clientTelemetryStore.record(
                        .firstFrameAcknowledged,
                        fingerprint: fingerprint,
                        sessionId: sessionId,
                        frameId: frameId
                    )
                }
            }
        )
        let transition = sessions.noteReady(active, ready: ready, transport: transport)
        if case .replaced(let previousSessionID) = transition {
            agentSessionTerminalEndpoints.endBinding(for: active.deviceFingerprint)
            workspaceTerminalEndpoints.endBinding(for: active.deviceFingerprint)
            signalingLogger.notice("retired terminal endpoint for replaced session fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public) previous=\(previousSessionID, privacy: .public) current=\(active.sessionId, privacy: .public)")
        }
        signalingLogger.notice("session ready fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public) session=\(active.sessionId, privacy: .public)")
        clientTelemetryStore.record(
            .sessionReady,
            fingerprint: active.deviceFingerprint,
            sessionId: active.sessionId
        )
        updateHostAvailability(.active, reason: "session-ready")
        startMediaTransport(transport, for: active)
        refreshConnectedState()
    }

    private func handleGraphicsLaneReady(_ fingerprint: DeviceFingerprint, lane: GraphicsLaneServer) {
        signalingLogger.notice("graphics lane ready fp=\(fingerprint.rawValue, privacy: .public)")
        guard let transport = sessions.transport(for: fingerprint) as? QuicSessionHostMediaTransport else {
            signalingLogger.error("graphics lane ready but no media transport for fp=\(fingerprint.rawValue, privacy: .public)")
            return
        }
        transport.attachGraphicsLane(lane)
    }

    // ADR-0038: the client opened its .dom lane; seed it from the relay's checkout buffer and go
    // live. Decoupled from the media transport -- DOM batches come from the Chrome bridge, not video.
    private func handleDomLaneReady(_ fingerprint: DeviceFingerprint, lane: DomEventLaneServer) {
        signalingLogger.notice("dom lane ready fp=\(fingerprint.rawValue, privacy: .public)")
        // ADR-0040: forward client taps read off the lane to the bridge, which relays them to the
        // extension for trusted dispatch. Kept on the DOM path, never the Mac input dispatcher.
        lane.onInput = { [weak self] raw in
            if let command = try? JSONDecoder().decode(BrowserProjectionViewerStateCommand.self, from: raw),
               command.type == "browser-viewer-state" {
                Task { @MainActor [weak self] in
                    self?.browserProjectionViewportCoordinator?.update(
                        command,
                        from: .remote(fingerprint)
                    )
                }
                return
            }
            // ADR-0047 scroll diagnostic: if the shim is not connected the command is silently
            // dropped and never reaches Chrome -- surface that so a "dead" scroll is distinguishable
            // from a slow one. Successful forwards stay unlogged (the dom-lane forward log already
            // timestamps each frame) to keep the 60Hz scroll stream readable.
            let accepted = self?.domBridgeServer?.sendToBridge(raw) ?? false
            if !accepted { self?.signalingLogger.notice("dom-lane input dropped: no bridge shim connected") }
        }
        lane.onReceiveEnded = { [weak self, weak lane] in
            guard let lane else { return }
            Task { @MainActor [weak self] in
                guard let self,
                      self.domMirrorRelay.detach(lane, for: fingerprint) else { return }
                self.browserProjectionViewportCoordinator?.remove(.remote(fingerprint))
            }
        }
        lane.startReceiving()
        domMirrorRelay.attach(lane, for: fingerprint)
        browserProjectionViewportCoordinator?.register(.remote(fingerprint), profile: .mobile)
    }

    private func handleTerminalLaneReady(_ fingerprint: DeviceFingerprint, bridge: TerminalClientBridge) {
        signalingLogger.notice("terminal lane ready fp=\(fingerprint.rawValue, privacy: .public)")
        let id = ObjectIdentifier(bridge)
        terminalClientBridges[id] = bridge
        bridge.onClose = { [weak self] in
            Task { @MainActor in
                self?.terminalClientBridges.removeValue(forKey: id)
            }
        }
        bridge.start()
    }
    private func handleWorkspaceLaneReady(_ fingerprint: DeviceFingerprint, lane: WorkspaceLaneServer) {
        signalingLogger.notice("workspace lane ready fp=\(fingerprint.rawValue, privacy: .public)")
        let id = ObjectIdentifier(lane)
        workspaceLanes[id] = lane
        let session = WorkspaceLaneSession(
            push: { [weak lane] response in try? await lane?.push(response) },
            files: workspaceFilesResponder,
            workspaces: workspaceCoordinator,
            ideState: workspaceIDEStateCoordinator,
            observation: workspaceObservationCoordinator
        )
        workspaceLaneSessions[id] = session
        lane.handleRequest = { [weak session] request in
            guard let session else {
                return .error(WorkspaceLaneError(
                    requestID: request.requestID,
                    code: .operationRejected
                ))
            }
            return await session.handle(request)
        }
        lane.onClose = { [weak self] in
            Task { @MainActor in
                await self?.workspaceLaneSessions.removeValue(forKey: id)?.stop()
                self?.workspaceLanes.removeValue(forKey: id)
            }
        }
        lane.start()
    }

    private func startPtyManager() {
        guard let managerURL = Config.ptyManagerURL, let vaultURL = Config.ptyVaultURL else {
            signalingLogger.error("PTY runtime binaries not found in bundle")
            return
        }
        let process = HostPtyRuntimeProcess(
            vaultBinaryURL: vaultURL,
            managerBinaryURL: managerURL
        )
        ptyRuntimeProcess = process
        process.start()
        terminalWindowRegistry.startRestoration()
    }

    // Start the Chrome-fed native-messaging bridge and pipe its batches into the relay, but only
    // when the subsystem is flag-enabled. onBatch fires on the bridge's own queue; the relay is
    // lock-guarded, so no MainActor hop is needed.
    private func startDomMirrorIfEnabled() {
        guard Config.domMirrorEnabled else { return }
        let relay = domMirrorRelay
        let server = DomBridgeServer()
        let hostSHA = (Bundle.main.infoDictionary?["AgentDeskGitSHA"] as? String)
            .flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
        relay.setHostSHA(hostSHA)
        let viewportCoordinator = BrowserProjectionViewportCoordinator { [weak server] payload in
            server?.sendToBridge(payload) ?? false
        }
        let projectionSession = BrowserProjectionSession(
            hostSHA: hostSHA,
            viewportCoordinator: viewportCoordinator
        ) { [weak server] payload in server?.sendToBridge(payload) ?? false }
        viewportCoordinator.onViewerStatus = { [weak projectionSession] viewer, payload in
            switch viewer {
            case .local:
                projectionSession?.receiveViewerStatus(payload)
            case .remote(let fingerprint):
                relay.send(payload, to: fingerprint)
            }
        }
        viewportCoordinator.register(.local, profile: .desktop)
        let projectionLane = BrowserProjectionLocalLane(session: projectionSession)
        server.onBatch = { raw, envelope in
            relay.ingest(line: raw, tabId: envelope.tabId, checkout: envelope.checkout)
            projectionLane.send(.batch(raw))
        }
        server.onBrowserState = { raw, state in
            relay.ingestBrowserState(raw)
            projectionLane.send(.browserState(raw, state))
        }
        // ADR-0046: reflect extension bridge liveness in the client's Browser status line.
        server.onBridgeConnected = {
            relay.setExtConnected(true)
            projectionLane.send(.bridgeConnected(true))
        }
        server.onBridgeDisconnected = {
            relay.setExtConnected(false)
            projectionLane.send(.bridgeConnected(false))
        }
        server.start()
        domBridgeServer = server
        browserProjectionSession = projectionSession
        browserProjectionLane = projectionLane
        browserProjectionViewportCoordinator = viewportCoordinator
        signalingLogger.notice("dom-mirror bridge started")
    }

    private func handleSessionResumeChallenge(_ request: SessionResumeInit) throws -> SessionResumeChallenge {
        guard (try? pairing.lookup(deviceFingerprint: request.deviceFingerprint)) != nil else {
            throw SessionRejected(reason: .unknownDevice)
        }
        switch sessions.makeResumeChallenge(request) {
        case .accepted(let challenge):
            return try signedResumeChallenge(challenge, request: request)
        case .rejected(let reason):
            throw SessionRejected(reason: reason)
        }
    }

    private func handleSessionResume(_ request: SessionResumeInit, proof: SessionResumeProof) throws -> (ActiveSession, SessionReady) {
        switch sessions.validateResume(request, proof: proof) {
        case .accepted(let active, let hostNonce):
            guard (try? pairing.lookup(deviceFingerprint: active.deviceFingerprint)) != nil else {
                sessions.endSession(active.deviceFingerprint, sessionId: active.sessionId)
                throw SessionRejected(reason: .unknownDevice)
            }
            let unsignedReady = try sessions.makeResumeReady(for: active.deviceFingerprint)
            let ready = try signedSessionReady(
                unsignedReady,
                deviceFingerprint: active.deviceFingerprint,
                clientNonce: request.clientNonce,
                hostNonce: hostNonce,
                protocolVersion: request.protocolVersion
            )
            signalingLogger.notice("session resuming fingerprint=\(active.deviceFingerprint.rawValue, privacy: .public) session=\(active.sessionId, privacy: .public)")
            return (active, ready)
        case .rejected(let reason):
            throw SessionRejected(reason: reason)
        }
    }

    private func signedResumeChallenge(_ challenge: SessionResumeChallenge, request: SessionResumeInit) throws -> SessionResumeChallenge {
        let key = try loadHostSigningKey(context: "session-resume-challenge")
        let hostFingerprint = key.publicKey.agentDeskFingerprint
        let signature = try key.signature(for: SessionResumeSigning.challengeInput(
            sessionId: request.sessionId,
            deviceFingerprint: request.deviceFingerprint,
            resumeId: request.resumeId,
            clientNonce: request.clientNonce,
            hostNonce: challenge.hostNonce,
            resumeExpiresAt: challenge.resumeExpiresAt,
            protocolVersion: request.protocolVersion,
            hostFingerprint: hostFingerprint
        )).rawRepresentation
        return SessionResumeChallenge(
            hostNonce: challenge.hostNonce,
            resumeExpiresAt: challenge.resumeExpiresAt,
            hostSignature: signature
        )
    }

    private func signedSessionReady(
        _ ready: SessionReady,
        deviceFingerprint: DeviceFingerprint,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int
    ) throws -> SessionReady {
        let key = try loadHostSigningKey(context: "session-resume-ready")
        let hostFingerprint = key.publicKey.agentDeskFingerprint
        let signature = try key.signature(for: SessionResumeSigning.readyInput(
            ready: ready,
            deviceFingerprint: deviceFingerprint,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: protocolVersion,
            hostFingerprint: hostFingerprint
        )).rawRepresentation
        return SessionReady(
            sessionId: ready.sessionId,
            resumeId: ready.resumeId,
            resumeSecret: ready.resumeSecret,
            resumeExpiresAt: ready.resumeExpiresAt,
            mediaKeySalt: ready.mediaKeySalt,
            hostSignature: signature
        )
    }

    private func loadHostSigningKey(context: String) throws -> HostSigningKey {
        do {
            return try pairing.signingKey()
        } catch {
            signalingLogger.error("host signing key unavailable context=\(context, privacy: .public) reason=\(String(describing: error), privacy: .public)")
            throw SessionRejected(reason: .signingKeyUnavailable)
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

    // The input lane died with the peer still notionally "connected". Treat it as
    // a suspend so the popover drops to "Paired but not currently connected" and the
    // stale-send flood stops; the resume-grace timer ends it fully if the phone does
    // not come back. sessionId is nil because a superseded lane is closed via
    // cancellation (which never fires onClosed), so the live lane's death always maps
    // to the current session for this fingerprint.
    private func handleInputLaneClosed(_ fingerprint: DeviceFingerprint) {
        guard sessions.isActive(fingerprint) else { return }
        if hostAvailability.preservesSessionOnInputLaneClose {
            signalingLogger.notice("input lane closed during availability=\(self.hostAvailability.availability.rawValue, privacy: .public) fp=\(fingerprint.rawValue, privacy: .public); preserving session")
            return
        }
        signalingLogger.notice("input lane closed by peer fp=\(fingerprint.rawValue, privacy: .public); suspending session")
        handleSessionSuspended(fingerprint, sessionId: nil)
    }

    // The phone asked to unpair (settings "Unpair / Forget host"). Remove the paired
    // record via the same path as the menubar Revoke button, ending the live session
    // and returning the popover to "No paired device".
    private func handleClientRevoke(_ fingerprint: DeviceFingerprint) {
        signalingLogger.notice("client requested unpair fp=\(fingerprint.rawValue, privacy: .public); removing pairing")
        revokeDevice(fingerprint)
    }

    private func handleSessionEnded(
        _ fingerprint: DeviceFingerprint,
        sessionId: String? = nil,
        closeSignaling: Bool = false
    ) {
        guard sessions.endSession(fingerprint, sessionId: sessionId) else {
            signalingLogger.notice("ignored stale session end fingerprint=\(fingerprint.rawValue, privacy: .public) session=\(sessionId ?? "nil", privacy: .public)")
            return
        }
        agentSessionTerminalEndpoints.endBinding(for: fingerprint)
        workspaceTerminalEndpoints.endBinding(for: fingerprint)
        thumbnailEnabledClients.remove(fingerprint)
        spaceThumbnailProvider.setDemand(owner: .client(fingerprint.rawValue), enabled: false)
        domMirrorRelay.detach(for: fingerprint)
        browserProjectionViewportCoordinator?.remove(.remote(fingerprint))
        updateHostAvailability(.disconnected, reason: "session-ended")
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
        let sessionId = sessions.sessionId(for: fingerprint)
        signalingLogger.notice("input lane ready fp=\(fingerprint.rawValue, privacy: .public)")
        sessions.attachInputChannelServer(server, for: fingerprint)
        clientTelemetryStore.record(
            .inputLaneReady,
            fingerprint: fingerprint,
            sessionId: sessionId
        )
        server.runtimeCheckpointHandler = { [weak self] checkpoint in
            self?.clientTelemetryStore.recordCheckpoint(checkpoint, fingerprint: fingerprint)
        }
        let diagnosticsBroker = ClientDiagnosticsBroker(
            server: server,
            announcementHandler: { [weak self] summary in
                self?.handleClientDiagnosticsAnnouncement(
                    summary,
                    fingerprint: fingerprint
                )
            }
        )
        sessions.attachDiagnosticsBroker(diagnosticsBroker, for: fingerprint)
        diagnosticsBroker.start()
        server.pushHostAvailability(HostAvailabilityPush(
            availability: hostAvailability.availability,
            reason: hostAvailability.reason
        ))
        let terminalEndpointBinding = agentSessionTerminalEndpoints.beginBinding(for: fingerprint)
        let terminalEndpointTask = Task { @MainActor [agentSessionTerminalEndpoints] in
            await agentSessionTerminalEndpoints.endpoint(
                for: fingerprint,
                binding: terminalEndpointBinding
            )
        }
        let terminalPushBindingID = UUID().uuidString
        let terminalPushBindingTask = Task {
            guard let terminalEndpoint = await terminalEndpointTask.value else { return }
            await terminalEndpoint.bindPush(id: terminalPushBindingID) { [weak server] message in
                server?.pushAgentTerminal(message)
            }
        }
        let workspaceTerminalEndpointBinding = workspaceTerminalEndpoints.beginBinding(for: fingerprint)
        let workspaceTerminalEndpointTask = Task { @MainActor [workspaceTerminalEndpoints] in
            await workspaceTerminalEndpoints.endpoint(
                for: fingerprint,
                binding: workspaceTerminalEndpointBinding
            )
        }
        let workspaceTerminalPushBindingID = UUID().uuidString
        let workspaceTerminalPushBindingTask = Task {
            guard let endpoint = await workspaceTerminalEndpointTask.value else { return }
            await endpoint.bindPush(id: workspaceTerminalPushBindingID) { [weak server] message in
                server?.pushWorkspaceTerminal(message)
            }
        }
        // The QUIC connection's state handler does not reliably fire .cancelled on a
        // half-dead socket, so the input lane dropping is our disconnect signal. Route
        // it through the existing suspend path (resume-grace, then end) so the popover
        // stops falsely reading "Connected" the moment the phone goes away.
        server.onClosed = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.clientTelemetryStore.record(
                    .inputLaneClosed,
                    fingerprint: fingerprint,
                    sessionId: sessionId,
                    errorCode: "input-lane-ended"
                )
                await terminalPushBindingTask.value
                if let terminalEndpoint = await terminalEndpointTask.value {
                    await terminalEndpoint.unbindPush(id: terminalPushBindingID)
                }
                await workspaceTerminalPushBindingTask.value
                if let endpoint = await workspaceTerminalEndpointTask.value {
                    await endpoint.unbindPush(id: workspaceTerminalPushBindingID)
                }
                self.handleInputLaneClosed(fingerprint)
            }
        }
        server.receiveErrorPreservationHandler = { [weak self] error in
            await MainActor.run {
                guard let self else { return false }
                let preserve = self.hostAvailability.preservesSessionOnInputLaneClose
                if preserve {
                    self.signalingLogger.notice("preserving input lane receive error during availability=\(self.hostAvailability.availability.rawValue, privacy: .public) fp=\(fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
                }
                return preserve
            }
        }
        // Explicit client-initiated unpair: drop the paired-device record, same as
        // the menubar "Revoke" button, so the popover returns to "No paired device".
        server.revokeHandler = { [weak self] in
            Task { @MainActor in
                self?.handleClientRevoke(fingerprint)
            }
        }
        // Wire the agent-feed bridge: construct it from the sidecar base URL and
        // a send closure that pushes already-encoded data back down the input lane,
        // mirroring how diagnostics pushes its responses.
        // Cancel any prior bridge's in-flight SSE streams before replacing it on a
        // lane re-attach (session resume), so the previous bridge's stream Tasks
        // do not keep iterating the sidecar byte stream.
        agentFeedBridge?.reset()
        // Wire the bridge UNCONDITIONALLY, even if the sidecar is not ready right
        // now. The sidecar can be mid-restart at the moment a session attaches (a
        // ~1s window); gating the wiring on readiness here disabled the feed for
        // the entire session even after the sidecar recovered ms later, which is
        // how the phone feed got stuck on "waiting" until an app reopen. The
        // sidecar base URL is resolved lazily per request, so a subscribe that
        // arrives once the sidecar is back succeeds, and one that arrives while it
        // is still down fails transiently and the client retries.
        let sidecar = agentFeedSidecar
        let httpClient = HttpSidecarClient(baseURLProvider: { [weak sidecar] in sidecar?.baseURL })
        let bridge = AgentFeedBridge(client: httpClient, send: { [weak server] data in
            server?.pushAgentData(data)
        })
        agentFeedBridge = bridge
        server.agentRequestHandler = { [weak bridge] request in
            switch request {
            case .projectsWatch(let request):
                bridge?.handleProjectsWatch(request)
            case .projectsUnwatch(let request):
                bridge?.handleProjectsUnwatch(request)
            case .projectSessionsWatch(let request):
                bridge?.handleProjectSessionsWatch(request)
            case .projectSessionsUnwatch(let request):
                bridge?.handleProjectSessionsUnwatch(request)
            case .threadSubscribe(let msg):
                bridge?.handleThreadSubscribe(msg)
            case .threadLoadOlder(let msg):
                bridge?.handleThreadLoadOlder(msg)
            case .threadUnsubscribe(let msg):
                bridge?.handleThreadUnsubscribe(msg)
            case .rawEvent(let msg):
                bridge?.handleRawEvent(msg)
            case .terminal(let message):
                Task {
                    await terminalPushBindingTask.value
                    guard let terminalEndpoint = await terminalEndpointTask.value else { return }
                    await terminalEndpoint.handle(message)
                }
            }
        }
        server.workspaceTerminalRequestHandler = { message in
            Task {
                await workspaceTerminalPushBindingTask.value
                guard let endpoint = await workspaceTerminalEndpointTask.value else { return }
                await endpoint.handle(message)
            }
        }
        // R11: push the current DesktopState as soon as the channel is
        // attached so the client can render the dots band immediately
        // on session start without waiting for a Spaces switch.
        if let state = currentDesktopState() {
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
        thumbnailsLogger.notice("client thumbnail default demand fp=\(clientFingerprint.rawValue, privacy: .public) enabled=true")
        thumbnailEnabledClients.insert(clientFingerprint)
        provider.setDemand(owner: thumbnailOwner, enabled: true)
        provider.forceRefresh()
        server.configHandler = { [weak self, server] config in
            let enabled = config.thumbnailsEnabled
            let refresh = config.thumbnailRefresh
            let selectedDisplayId = config.selectedDisplayId
            // nil = client expressed no crisp opinion -> host keeps its default (on); the
            // transport composes this with Config.ownedMediaCrispEnabled as the hard gate.
            let crispEnabled = config.crispTextOverlayEnabled ?? true
            // nil = no opinion -> host keeps its default (cursor NOT baked into video; the
            // client overlay is the cursor).
            let showHostCursor = config.showHostCursorInVideo ?? false
            // nil = no opinion -> adaptive media quality remains on, matching ADR-0033.
            let mediaQuality = config.mediaQuality ?? ClientMediaQualityConfig(adaptiveEnabled: true)
            let autoKeyboardEnabled = config.autoKeyboardEnabled
            Task { @MainActor [weak self, provider, thumbnailOwner, server] in
                guard let self else { return }
                let transport = self.sessions.transport(for: clientFingerprint)
                transport?.setClientCrispEnabled(crispEnabled)
                transport?.setClientMediaQuality(mediaQuality)
                (self.frameSource as? DisplaySelectableVideoFrameSource)?.setShowsCursorInVideo(showHostCursor)
                if self.textInputFocusProbeGate.apply(autoKeyboardEnabled: autoKeyboardEnabled, for: clientFingerprint) {
                    self.textInputFocusProbeCoordinator.cancel(for: clientFingerprint)
                }
                let fixedTarget = mediaQuality.fixedTarget
                self.thumbnailsLogger.notice("client thumbnail config fp=\(clientFingerprint.rawValue, privacy: .public) enabled=\(enabled, privacy: .public) refresh=\(String(describing: refresh), privacy: .public) selectedDisplay=\(selectedDisplayId ?? "nil", privacy: .public) crisp=\(crispEnabled, privacy: .public) autoKeyboard=\(autoKeyboardEnabled, privacy: .public) adaptiveQuality=\(mediaQuality.adaptiveEnabled, privacy: .public) fixedBitrateKbps=\(fixedTarget?.bitrateKbps ?? 0, privacy: .public) fixedFps=\(fixedTarget?.fps ?? 0, privacy: .public) fixedResolutionScale=\(fixedTarget?.resolutionScale ?? 0, privacy: .public)")
                if enabled {
                    self.thumbnailEnabledClients.insert(clientFingerprint)
                } else {
                    self.thumbnailEnabledClients.remove(clientFingerprint)
                    server.pushThumbnails([:])
                }
                provider.setDemand(owner: thumbnailOwner, enabled: enabled)
                if enabled {
                    provider.forceRefresh()
                }
                if let spaceId = refresh {
                    provider.forceRefresh(spaceId: spaceId)
                }
                if let selectedDisplayId, selectedDisplayId != self.displaySelection.selectedDisplayId {
                    let available = Set(self.spacesProvider.current()?.displays.map(\.id) ?? [])
                    guard self.displaySelection.select(selectedDisplayId, availableDisplayIds: available) else {
                        return
                    }
                    (self.frameSource as? DisplaySelectableVideoFrameSource)?.selectDisplay(
                        id: self.displaySelection.selectedDisplayId
                    )
                    self.broadcastDesktopState()
                    if enabled {
                        provider.forceRefresh()
                    }
                }
            }
        }
        let dispatcher = inputDispatcher
        let scrollActivityHints = scrollActivityHints
        let logger = signalingLogger
        let scheduleTextFocusProbe: @Sendable () -> Void = { [weak self, weak server] in
            Task { @MainActor in
                guard let self, let server else { return }
                guard self.textInputFocusProbeGate.canScheduleProbe(for: fingerprint) else { return }
                self.textInputFocusProbeCoordinator.schedule(for: fingerprint, server: server)
            }
        }
        sessions.attachInputTask(
            Task { [server, dispatcher, scrollActivityHints, logger, scheduleTextFocusProbe] in
                for await frame in server.events {
                    let input = frame.event
                    scrollActivityHints.record(input)
                    dispatcher.dispatch(
                        input,
                        cursorRevision: frame.cursorRevision,
                        cursorAppliedHandler: { revision, result in
                            server.pushCursorApplied(CursorAppliedPush(
                                cursorRevision: revision,
                                displayId: result.displayId,
                                cursorX: Float(result.position.x),
                                cursorY: Float(result.position.y)
                            ))
                        },
                        afterDispatch: {
                            guard case .click(.left) = input else { return }
                            scheduleTextFocusProbe()
                        }
                    )
                }
                logger.notice("input event stream finished")
                Task { @MainActor [weak self] in
                    self?.textInputFocusProbeCoordinator.cancel(for: fingerprint)
                    self?.textInputFocusProbeGate.remove(fingerprint)
                }
            },
            for: fingerprint
        )
    }

    private func handleVoiceLaneReady(
        _ fingerprint: DeviceFingerprint,
        lane: VoiceLaneServer
    ) {
        let sidecar = voiceEngineSidecar
        signalingLogger.notice(
            "voice lane ready fp=\(fingerprint.rawValue, privacy: .public)"
        )
        lane.start(baseURLProvider: { [weak sidecar] in sidecar?.baseURL })
    }

    private func handleClientDiagnosticsAnnouncement(
        _ summary: DiagnosticsSummary,
        fingerprint: DeviceFingerprint
    ) {
        guard clientTelemetryStore.needsIngest(summary, fingerprint: fingerprint),
              let broker = sessions.diagnosticsBroker(for: fingerprint) else {
            return
        }
        let runId = summary.runs.last?.runId
        clientTelemetryStore.record(
            .automaticIngestStarted,
            fingerprint: fingerprint,
            clientRunId: runId
        )
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let collected = try await broker.collect(DiagnosticsRequest(
                    requestId: "auto-\(UUID().uuidString.lowercased())",
                    sinceRunId: nil,
                    includePreviousRuns: true,
                    maxBytes: 768 * 1_024
                ))
                try self.clientTelemetryStore.store(collected, fingerprint: fingerprint)
                self.clientTelemetryStore.record(
                    .automaticIngestCompleted,
                    fingerprint: fingerprint,
                    clientRunId: collected.summary.runs.last?.runId
                )
            } catch {
                self.clientTelemetryStore.record(
                    .automaticIngestFailed,
                    fingerprint: fingerprint,
                    clientRunId: runId,
                    errorCode: String(describing: type(of: error))
                )
                self.signalingLogger.error(
                    "automatic client diagnostics ingest failed fp=\(fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)"
                )
            }
        }
    }

    private func routeAgentSessionTerminalEvent(
        _ event: AgentSessionTerminalCoordinatorEvent
    ) async {
        await agentWindowRegistry?.handleCoordinatorEvent(event)
        for endpoint in agentSessionTerminalEndpoints.activeEndpoints {
            await endpoint.handleCoordinatorEvent(event)
        }
    }

    private func routeWorkspaceTerminalEvent(
        _ event: WorkspaceTerminalCoordinatorEvent
    ) async {
        await localWorkspaceTerminalEndpoint?.handleCoordinatorEvent(event)
        for endpoint in workspaceTerminalEndpoints.activeEndpoints {
            await endpoint.handleCoordinatorEvent(event)
        }
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
                self.thumbnailsLogger.notice("thumbnail broadcast thumbnails=\(thumbnails.count, privacy: .public) topWindows=\(topWindows.count, privacy: .public) clients=\(enabledClients.count, privacy: .public) ids=\(thumbnails.keys.map { String($0) }.sorted().joined(separator: ","), privacy: .public)")
                for (fingerprint, server) in registry.allInputChannelServersByFingerprint()
                    where enabledClients.contains(fingerprint) {
                    server.pushThumbnails(thumbnails, topWindows: topWindows)
                }
            }
        }
    }

    private func currentDesktopState() -> DesktopState? {
        guard let state = spacesProvider.current() else { return nil }
        let fallback = state.selectedDisplayId ?? state.activeDisplayId ?? state.displays.first?.id
        if displaySelection.selectDefaultIfNeeded(fallback) {
            return spacesProvider.current() ?? state
        }
        return state
    }

    private func broadcastDesktopState() {
        guard let state = currentDesktopState() else { return }
        for server in sessions.allInputChannelServers() {
            server.pushDesktopState(state)
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
        let transcriber = TranscriptionClient()
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
        // And keep dodging as the handle is dragged or the popover resizes.
        spaceAgentController?.onHandleFrameDidChange = { [weak self] in
            self?.dictationBarController?.keepClearOfSpaceAgentHandle()
        }
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

    private func installLockAvailabilityObserver() {
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(
            forName: NSWorkspace.sessionDidResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.updateHostAvailability(.locked, reason: "session-resigned-active")
            }
        }
        center.addObserver(
            forName: NSWorkspace.screensDidSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.updateHostAvailability(.captureUnavailable, reason: "screens-did-sleep")
            }
        }
        center.addObserver(
            forName: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.updateHostAvailability(.active, reason: "session-became-active")
            }
        }
        center.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.updateHostAvailability(.active, reason: "screens-did-wake")
            }
        }
    }

    private func updateHostAvailability(_ availability: HostAvailability, reason: String) {
        let snapshot: HostAvailabilitySnapshot?
        switch availability {
        case .active:
            snapshot = hostAvailability.noteActive(reason: reason)
        case .locked:
            snapshot = hostAvailability.noteLock(reason: reason)
        case .captureUnavailable:
            snapshot = hostAvailability.noteCaptureUnavailable(reason: reason)
        case .disconnected:
            snapshot = hostAvailability.noteDisconnected(reason: reason)
        }
        guard let snapshot else { return }
        signalingLogger.notice("host availability=\(snapshot.availability.rawValue, privacy: .public) reason=\(snapshot.reason ?? "nil", privacy: .public)")
        broadcastHostAvailability(snapshot)
    }

    private func broadcastHostAvailability(_ snapshot: HostAvailabilitySnapshot) {
        let push = HostAvailabilityPush(availability: snapshot.availability, reason: snapshot.reason)
        for server in sessions.allInputChannelServers() {
            server.pushHostAvailability(push)
        }
    }

    // Cursor mirror: CursorMonitor polls NSCursor.currentSystem and emits
    // a CursorImagePush on every shape change. Broadcast each change to all
    // attached clients. Runs for the process lifetime; a fresh client is
    // separately seeded with `cursorMonitor.latest` on attach.
    private func installCursorMonitor() {
        let registry = sessions
        let logger = signalingLogger
        cursorMonitor.onChange = { [weak registry] push in
            guard let registry else { return }
            logger.debug("host cursor kind changed kind=\(push.cursorKind.rawValue, privacy: .public) hash=\(push.hash, privacy: .public) hidden=\(push.hidden, privacy: .public)")
            for server in registry.allInputChannelServers() {
                server.pushCursor(push)
            }
        }
        cursorMonitor.start()
    }

    // Cursor position correction. Revisioned remote input is acknowledged by
    // the originating InputChannelServer directly from the dispatch loop.
    // CursorMonitor handles only independently observed Mac movement while the
    // remote stream is idle, preserving the provenance split from ADR-0058.
    private func installCursorPositionMonitor() {
        cursorMonitor.shouldEmitPosition = { [weak self] in
            guard let self else { return false }
            return !self.inputDispatcher.isCursorInputActive()
        }
        cursorMonitor.onPositionChange = { [weak self] position in
            self?.broadcastHostCursorMoved(position)
        }
    }

    private func broadcastHostCursorMoved(_ position: CGPoint) {
        let displayId = displaySelection.selectedDisplayId
        let bounds = displaySelection.selectedBounds()
        let clamped = InputDispatcher.clamp(position, to: bounds)
        for server in sessions.allInputChannelServers() {
            server.pushHostCursorMoved(
                displayId: displayId,
                cursorX: Float(clamped.x),
                cursorY: Float(clamped.y)
            )
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
        inputDispatcher.systemCommandHandler = { command in
            switch command {
            case .missionControl:
                provider.openMissionControl()
            }
        }
    }

    private func handleMediaConnectionState(_ state: MediaConnectionState, for fingerprint: DeviceFingerprint) {
        signalingLogger.notice("media state=\(String(describing: state), privacy: .public) fingerprint=\(fingerprint.rawValue, privacy: .public)")
        switch state {
        case .connecting:
            break
        case .connected:
            updateHostAvailability(.active, reason: "media-connected")
        case .disconnected:
            updateHostAvailability(.captureUnavailable, reason: "media-disconnected")
        case .failed, .closed:
            updateHostAvailability(.captureUnavailable, reason: "media-\(String(describing: state))")
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
            // ADR-0049: list every online iOS peer, not only the ones whose
            // AgentDesk app is currently listening. The whois probe below no
            // longer gates the list; it only enriches names for devices that are
            // ready, so a closed-app iPhone still appears and can be pre-armed.
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
            // Probe every candidate concurrently for its client-reported name.
            // A responder is ready to pair now; a non-responder is listed anyway.
            let readyNames = await withTaskGroup(of: (String, String)?.self) { group in
                for peer in candidates {
                    group.addTask {
                        guard let identity = await prober.identify(ipv4: peer.ipv4) else {
                            return nil
                        }
                        return (peer.ipv4, identity.displayName)
                    }
                }
                var names: [String: String] = [:]
                for await result in group {
                    if let (ipv4, name) = result { names[ipv4] = name }
                }
                return names
            }
            let rows = PairablePeer.rows(candidates: candidates, readyNames: readyNames)
            self.popoverController.render(.devicePicker(rows))
        }
    }

    // ADR-0049: picking a device is the host-side authorization. A device whose
    // app is listening (ready) gets an offer pushed immediately; a device whose
    // app is closed is pre-armed and the readiness poll fires the same push once
    // its app comes up, so the user never has to come back and re-pick.
    private func pairWithDevice(_ device: PairablePeer) {
        if device.ready {
            sendOffer(toIPv4: device.ipv4, name: device.displayName)
        } else {
            preArm(device)
        }
    }

    // ADR-0019/0049: mint an offer, pre-approve its nonce tagged with the picked
    // device name (the pick is the authorization), and push it to the chosen
    // device over the tailnet. The iPhone runs the unchanged handshake and the
    // host auto-approves, recording the device name so the popover shows it. Any
    // pre-arm for this IPv4 is cleared: the offer supersedes the waiting intent.
    private func sendOffer(toIPv4 ipv4: String, name: String) {
        preArmPollTasks[ipv4]?.cancel()
        preArmPollTasks[ipv4] = nil
        try? preArmStore.disarm(ipv4: ipv4)
        if activePreArmName == name { activePreArmName = nil }
        do {
            let payload = try pairing.mintPairingPayload()
            pairing.markPreApproved(nonce: payload.oneTimeNonce, name: name)
            applyIcon(.pairing)
            popoverController.render(.pairingOffered(name))
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
            signalingLogger.error("sendOffer failed: \(String(describing: error), privacy: .public)")
            applyIcon(.pairingFailed)
            popoverController.render(.idle)
        }
    }

    // ADR-0049: remember a device picked while its app was closed, persist the
    // intent so it survives a host restart, and start polling its offer port for
    // readiness. The poll fires sendOffer once the app answers.
    private func preArm(_ device: PairablePeer) {
        let now = Int(Date().timeIntervalSince1970)
        let target = PreArmedTarget(
            ipv4: device.ipv4,
            name: device.displayName,
            armedAt: now,
            expiresAt: now + Int(Config.preArmTTL)
        )
        do {
            try preArmStore.arm(target)
        } catch {
            signalingLogger.error("pre-arm persist failed: \(String(describing: error), privacy: .public)")
        }
        activePreArmName = device.displayName
        applyIcon(.pairing)
        popoverController.render(.preArmed(device.displayName))
        startPreArmPoll(ipv4: device.ipv4, name: device.displayName)
    }

    // Poll one pre-armed device's offer port until its app answers whois (then
    // push the offer) or the intent expires or is cancelled. One task per IPv4.
    private func startPreArmPoll(ipv4: String, name: String) {
        preArmPollTasks[ipv4]?.cancel()
        let interval = UInt64(Config.preArmPollInterval * 1_000_000_000)
        preArmPollTasks[ipv4] = Task { @MainActor [weak self] in
            let prober = TailnetIdentityProber()
            while true {
                if Task.isCancelled { return }
                guard let self, self.isPreArmLive(ipv4: ipv4) else {
                    self?.expirePreArm(ipv4: ipv4, name: name)
                    return
                }
                if await prober.identify(ipv4: ipv4) != nil {
                    self.signalingLogger.notice("pre-armed device came up \(ipv4, privacy: .public)")
                    self.sendOffer(toIPv4: ipv4, name: name)
                    return
                }
                try? await Task.sleep(nanoseconds: interval)
            }
        }
    }

    private func isPreArmLive(ipv4: String) -> Bool {
        let now = Int(Date().timeIntervalSince1970)
        let targets = (try? preArmStore.load()) ?? []
        return targets.contains { $0.ipv4 == ipv4 && $0.expiresAt > now }
    }

    // The intent's TTL passed (or it was disarmed elsewhere): drop it and, if the
    // waiting popover was showing this device, fall back to the resting state.
    private func expirePreArm(ipv4: String, name: String) {
        preArmPollTasks[ipv4] = nil
        try? preArmStore.disarm(ipv4: ipv4)
        if activePreArmName == name {
            activePreArmName = nil
            signalingLogger.notice("pre-arm expired for \(ipv4, privacy: .public)")
            refreshConnectedState()
        }
    }

    // User dismissed the waiting popover: drop all pre-arm intents and their polls.
    private func cancelPreArms() {
        for (_, task) in preArmPollTasks { task.cancel() }
        preArmPollTasks.removeAll()
        try? preArmStore.save([])
        activePreArmName = nil
        refreshConnectedState()
    }

    // ADR-0049: on launch, resume polling any pre-arm intent that outlived a host
    // restart, and drop expired ones. Without this a device picked before the
    // host restarted would silently never pair.
    private func resumePreArms() {
        let now = Int(Date().timeIntervalSince1970)
        let live = (try? preArmStore.liveTargets(now: now)) ?? []
        guard !live.isEmpty else { return }
        activePreArmName = live.max(by: { $0.armedAt < $1.armedAt })?.name
        for target in live {
            startPreArmPoll(ipv4: target.ipv4, name: target.name)
        }
    }

    private func startPairing(writeAutomationURL: Bool = false) {
        do {
            let payload = try pairing.mintPairingPayload()
            let url = try payload.pairingURL()
            signalingLogger.notice("pairing URL minted expiresAt=\(payload.expiresAt, privacy: .public)")
            if writeAutomationURL {
                try writeAutomationPairingURL(url)
            }
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

    private func writeAutomationPairingURL(_ url: URL) throws {
        let fileURL = Config.devLastPairURLPath
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try url.absoluteString.write(to: fileURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: fileURL.path
        )
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
            // ADR-0049: no paired device, but if a pre-arm is waiting for a phone
            // to open, keep showing that rather than the bare idle screen.
            if let name = activePreArmName {
                applyIcon(.pairing)
                popoverController.render(.preArmed(name))
            } else {
                applyIcon(.idle)
                popoverController.render(.idle)
            }
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
        if Config.autoApprovePairing {
            signalingLogger.notice("auto-approving pairing (dev run) \(fingerprint.rawValue, privacy: .public)")
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
