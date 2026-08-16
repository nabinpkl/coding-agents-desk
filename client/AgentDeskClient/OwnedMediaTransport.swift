import CryptoKit
import Foundation
import Network
import OSLog
import Security
import AgentDeskWire
import PtyClientSwift

/// Which inbound `.agent`-role frames the native shell must handle itself rather than forward
/// verbatim to the panel webview. The webview is the authority on the rest of the `agent-*`
/// protocol — it decodes by `t` and ignores anything it does not yet know — so this is the only
/// client-side list that has to change when the agent protocol grows.
enum AgentPanelLaneRouting: Sendable {
    static let nativeInterceptedTypes: Set<String> = [
        "agent-say",                       // native TTS speech banner
        "agent-terminal-ready",           // native agent-terminal lifecycle
        "agent-terminal-ended",
        "agent-terminal-error",
        "agent-panel-origin",             // which build the panel webview loads (ADR-0096)
    ]

    static func isPanelProtocol(_ type: String) -> Bool {
        type.hasPrefix("agent-") && !nativeInterceptedTypes.contains(type)
    }
}

@available(iOS 26.0, *)
final class QuicSessionClientTransport: InputChannel, MediaTransport, SessionTransport, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "session-quic")
    /// Everything whose lifetime is the QUIC connection's, in one box so `close()` can let go
    /// of all of it at once.
    ///
    /// `NetworkConnection` has no `cancel()` or `close()`: its only teardown is deinit, so the
    /// connection lives exactly as long as the last reference to it. That made closing a
    /// transport unable to close its connection, because three long-lived tasks capture the
    /// transport strongly -- the media-state observer, the `start()` task, and
    /// `VoiceAssetProvisioner`'s stored task, which outlives a session by the length of an
    /// asset download. The host kept the dead connection (measured: 7.4s in
    /// `waiting(Network is down)`), the next redial collided with it and was reset with
    /// ENOTCONN 58ms after becoming ready, and that reset cost a whole reconnect attempt on
    /// every handover (R230).
    ///
    /// Holding the resources separately from the object fixes that: whoever still holds the
    /// transport no longer holds the connection, so releasing here is releasing for real.
private struct Channels {
        let connection: NetworkConnection<QUIC>
        let inputStream: QUIC.Stream<QUICStream>
        // ADR-0034 crisp-repair: the reliable lane the host pushes crisp tiles on.
        let graphicsStream: QUIC.Stream<QUICStream>
        let datagrams: QUIC.Datagrams<QUICDatagram>
        // The Agent panel protocol (.agent role), carried on its own stream so the client forwards
        // it verbatim to the panel webview instead of demuxing it off the shared input lane.
        let agentStream: QUIC.Stream<QUICStream>
    }
    private let channels: OSAllocatedUnfairLock<Channels?>

    /// The live channels, or a thrown error once closed. Deliberately throwing rather than
    /// optional-and-silent: a send after close is a caller using a dead transport, and the
    /// old behaviour of quietly doing nothing is what lets that go unnoticed.
    private func liveChannels() throws -> Channels {
        guard let live = channels.withLock({ $0 }) else {
            throw QuicSessionTransportClosed()
        }
        return live
    }

    private var connection: NetworkConnection<QUIC> { get throws { try liveChannels().connection } }
    private var inputStream: QUIC.Stream<QUICStream> { get throws { try liveChannels().inputStream } }
    private var graphicsStream: QUIC.Stream<QUICStream> { get throws { try liveChannels().graphicsStream } }
    private var datagrams: QUIC.Datagrams<QUICDatagram> { get throws { try liveChannels().datagrams } }
    private var agentStream: QUIC.Stream<QUICStream> { get throws { try liveChannels().agentStream } }
    private let mediaRepairBuffer = MediaDatagramFrameRepairBuffer(
        trackedFrameLimit: Config.ownedMediaTrackedFrameLimit,
        maxResendPackets: Config.ownedMediaMaxResendPackets
    )
    private let desktopStateContinuation: AsyncStream<DesktopState>.Continuation
    let desktopStateUpdates: AsyncStream<DesktopState>
    private let thumbnailsContinuation: AsyncStream<[String: String]>.Continuation
    let thumbnailsUpdates: AsyncStream<[String: String]>
    private let topWindowsContinuation: AsyncStream<[String: SpaceTopWindow]>.Continuation
    let topWindowsUpdates: AsyncStream<[String: SpaceTopWindow]>
    private let windowListContinuation: AsyncStream<WindowListPush>.Continuation
    let windowListUpdates: AsyncStream<WindowListPush>
    private let agentSayContinuation: AsyncStream<AgentSayPush>.Continuation
    let agentSayUpdates: AsyncStream<AgentSayPush>
    private let agentPanelOriginContinuation: AsyncStream<AgentPanelOriginPush>.Continuation
    let agentPanelOriginUpdates: AsyncStream<AgentPanelOriginPush>
    private let cursorContinuation: AsyncStream<CursorImagePush>.Continuation
    let cursorUpdates: AsyncStream<CursorImagePush>
    private let cursorReconciliationContinuation: AsyncStream<CursorReconciliationUpdate>.Continuation
    let cursorReconciliationUpdates: AsyncStream<CursorReconciliationUpdate>
    private let hostAvailabilityContinuation: AsyncStream<HostAvailabilityPush>.Continuation
    let hostAvailabilityUpdates: AsyncStream<HostAvailabilityPush>
    private let textInputFocusContinuation: AsyncStream<HostTextInputFocusPush>.Continuation
    let textInputFocusUpdates: AsyncStream<HostTextInputFocusPush>
    private let diagnosticsContinuation: AsyncStream<InputChannelDiagnosticsUpdate>.Continuation
    let diagnosticsUpdates: AsyncStream<InputChannelDiagnosticsUpdate>
    private let screenshotContinuation: AsyncStream<InputChannelScreenshotUpdate>.Continuation
    let screenshotUpdates: AsyncStream<InputChannelScreenshotUpdate>
    private let agentTerminalContinuation: AsyncStream<AgentTerminalHostMessage>.Continuation
    let agentTerminalUpdates: AsyncStream<AgentTerminalHostMessage>
    private let workspaceTerminalContinuation: AsyncStream<WorkspaceTerminalHostMessage>.Continuation
    let workspaceTerminalUpdates: AsyncStream<WorkspaceTerminalHostMessage>
    private let closedContinuation: AsyncStream<Void>.Continuation
    let closed: AsyncStream<Void>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    // ADR-0088: link telemetry. Both are edge-triggered, so they cost nothing while the link
    // is stable and only produce work during the transitions we are trying to catch.
    private let pathObserver: LinkPathObserver
    private let radioObserver: RadioAccessObserver
    // Phase 1 of the handover architecture: fuses the path, address, and radio signals and
    // reports which one noticed a link change first. Observes only -- nothing acts on it yet,
    // deliberately, because the trigger should be chosen from a device measurement rather than
    // a guess (the existing resume path was wired to `willEnterForeground`, which cannot fire
    // during a network change because the app never leaves the foreground).
    private let changeDetector: LinkChangeDetector
    /// Whether our control datagrams are actually leaving the device. Edge-triggered: one line
    /// when sends start failing, one when they resume, never one per message. See
    /// `sendVideoControl`.
    private let controlSendHealth = OSAllocatedUnfairLock(initialState: ControlSendHealth())
    /// ADR-0104: the session's liveness monitor. Owned by `PairingClient` and ADOPTED here,
    /// never created here, because this object lives exactly as long as one carrier and the
    /// clock must not: a redial replaces the transport, and the time-without-evidence spent on
    /// the previous carrier has to keep counting or silence could never accumulate across a
    /// redial storm. Nil only for the moment between construction and adoption.
    private let livenessMonitor = OSAllocatedUnfairLock<SessionLivenessMonitor?>(initialState: nil)
    /// Set when the link detector sees the path move: the next report tick sends a ping
    /// immediately instead of waiting out the quiet interval. A hint about when to ask,
    /// never a verdict -- the old design's grace timer here killed a real handover 98ms
    /// before the new path came up.
    private let pingNow = OSAllocatedUnfairLock(initialState: false)
    /// When this carrier came up, for `SessionCarrierStaleness`: a fresh carrier gets its
    /// full grace to produce evidence before it can be called quiet.
    private let carrierStartedNs = DispatchTime.now().uptimeNanoseconds
    /// One staleness report per carrier -- the report replaces the carrier, so a second one
    /// would be a second teardown racing the first.
    private let carrierStaleReported = OSAllocatedUnfairLock(initialState: false)
    private let lock = OSAllocatedUnfairLock<State>(initialState: State())
    private var datagramReceiveTask: Task<Void, Never>?
    private var inputReceiveTask: Task<Void, Never>?
    private var agentReceiveTask: Task<Void, Never>?
    private var graphicsReceiveTask: Task<Void, Never>?
    private var linkHealthTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?
    // Set by PairingViewController to forward raw agent push JSON to AgentFeedSurface.
    // Called on the input-receive task (not MainActor); AgentFeedSurface.deliver
    // is @MainActor-isolated so the closure must hop to the main actor.
    var onAgentPush: ((String) -> Void)?

    let activeSession: ActiveSession
    let mediaKey: SymmetricKey

    init(
        connection: NetworkConnection<QUIC>,
        inputStream: QUIC.Stream<QUICStream>,
        graphicsStream: QUIC.Stream<QUICStream>,
        datagrams: QUIC.Datagrams<QUICDatagram>,
        activeSession: ActiveSession,
        mediaKey: SymmetricKey,
        agentStream: QUIC.Stream<QUICStream>
    ) {
        self.channels = OSAllocatedUnfairLock(initialState: Channels(
            connection: connection,
            inputStream: inputStream,
            graphicsStream: graphicsStream,
            datagrams: datagrams,
            agentStream: agentStream
        ))
        self.activeSession = activeSession
        self.mediaKey = mediaKey

        // ADR-0088: records every path transition as it happens, independent of the 500ms
        // report cadence, so a transition that lands mid-window is timestamped where it
        // actually occurred rather than smeared to the window boundary. Captures its own
        // logger rather than self, which is not yet initialised here.
        let telemetryLogger = Logger(subsystem: Config.logSubsystem, category: "link-telemetry")
        // The detector is built first so both observers can feed it. It logs each transition as
        // it happens rather than only at the report boundary, because the ordering between
        // causes -- which signal saw the handover first -- is the measurement Phase 1 exists
        // for, and a 500ms window would flatten it.
        let detector = LinkChangeDetector { event in
            telemetryLogger.notice("link change \(event.logDescription, privacy: .public)")
        }
        changeDetector = detector
        pathObserver = LinkPathObserver { snapshot in
            telemetryLogger.notice("link path changed \(snapshot.logDescription, privacy: .public)")
            detector.notePath(snapshot)
        }
        radioObserver = RadioAccessObserver { from, to in
            detector.noteRadioChange(from: from, to: to)
        }

        var dsCont: AsyncStream<DesktopState>.Continuation!
        desktopStateUpdates = AsyncStream { dsCont = $0 }
        desktopStateContinuation = dsCont
        var thCont: AsyncStream<[String: String]>.Continuation!
        thumbnailsUpdates = AsyncStream { thCont = $0 }
        thumbnailsContinuation = thCont
        var twCont: AsyncStream<[String: SpaceTopWindow]>.Continuation!
        topWindowsUpdates = AsyncStream { twCont = $0 }
        topWindowsContinuation = twCont
        var wlCont: AsyncStream<WindowListPush>.Continuation!
        windowListUpdates = AsyncStream { wlCont = $0 }
        windowListContinuation = wlCont
        var sayCont: AsyncStream<AgentSayPush>.Continuation!
        agentSayUpdates = AsyncStream { sayCont = $0 }
        agentSayContinuation = sayCont
        var panelOriginCont: AsyncStream<AgentPanelOriginPush>.Continuation!
        agentPanelOriginUpdates = AsyncStream { panelOriginCont = $0 }
        agentPanelOriginContinuation = panelOriginCont
        var cursorCont: AsyncStream<CursorImagePush>.Continuation!
        cursorUpdates = AsyncStream { cursorCont = $0 }
        cursorContinuation = cursorCont
        var cursorReconciliationCont: AsyncStream<CursorReconciliationUpdate>.Continuation!
        cursorReconciliationUpdates = AsyncStream { cursorReconciliationCont = $0 }
        cursorReconciliationContinuation = cursorReconciliationCont
        var availabilityCont: AsyncStream<HostAvailabilityPush>.Continuation!
        hostAvailabilityUpdates = AsyncStream { availabilityCont = $0 }
        hostAvailabilityContinuation = availabilityCont
        var textInputFocusCont: AsyncStream<HostTextInputFocusPush>.Continuation!
        textInputFocusUpdates = AsyncStream { textInputFocusCont = $0 }
        textInputFocusContinuation = textInputFocusCont
        var diagnosticsCont: AsyncStream<InputChannelDiagnosticsUpdate>.Continuation!
        diagnosticsUpdates = AsyncStream { diagnosticsCont = $0 }
        diagnosticsContinuation = diagnosticsCont
        var screenshotCont: AsyncStream<InputChannelScreenshotUpdate>.Continuation!
        screenshotUpdates = AsyncStream(bufferingPolicy: .bufferingNewest(2)) { screenshotCont = $0 }
        screenshotContinuation = screenshotCont
        var agentTerminalCont: AsyncStream<AgentTerminalHostMessage>.Continuation!
        agentTerminalUpdates = AsyncStream { agentTerminalCont = $0 }
        agentTerminalContinuation = agentTerminalCont
        var workspaceTerminalCont: AsyncStream<WorkspaceTerminalHostMessage>.Continuation!
        workspaceTerminalUpdates = AsyncStream { workspaceTerminalCont = $0 }
        workspaceTerminalContinuation = workspaceTerminalCont
        var closedCont: AsyncStream<Void>.Continuation!
        closed = AsyncStream { closedCont = $0 }
        closedContinuation = closedCont
        var stateCont: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { stateCont = $0 }
        stateContinuation = stateCont

        // The initialiser parameter, not the accessor: this runs before anything can close,
        // and the accessor throws.
        connection.onStateUpdate { [weak self] _, state in
            self?.handleConnectionState(state)
        }
        startInputReceiveLoop()
        startAgentReceiveLoop()
        startDatagramReceiveLoop()
        // The graphics lane starts in start(), once the sink exists: it announces the lane
        // (prompting the host to push) only after there is a sink to consume the frames, so
        // the host's resetSurface + first tiles are never dropped before the sink is set.
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        stateContinuation.yield(.connected)
        if let mediaSink = videoSink as? any OwnedMediaFrameSink {
            // Set the sink on the MainActor, where every reader (the graphics and datagram
            // loops) also touches it, so the write and reads stay on one actor.
            await MainActor.run { [weak self, weak mediaSink] in
                self?.sink = mediaSink
                // Through the shared path, not an inline copy of it: a keyframe request is the
                // message most likely to be sent into a broken link and the one whose loss
                // hurts most, so it must be covered by the send-failure reporting too.
                mediaSink?.setVideoKeyframeRequestHandler { [weak self] hasReferences, reason in
                    self?.sendVideoControl(
                        OwnedMediaControlMessage(
                            kind: .keyframeRequest,
                            frameId: 0,
                            reason: reason,
                            clientHasNoReferences: hasReferences ? nil : true
                        )
                    )
                }
                // ADR-0090: an acknowledged long-term reference is what lets the host answer
                // the next resync with a delta instead of a keyframe. Sent as its own frame ack
                // rather than batched: long-term references are periodic, not per-frame, so the
                // volume is low, and delaying one only delays when the cheap path unlocks.
                mediaSink?.setLtrAcknowledgementHandler { [weak self] token in
                    self?.sendVideoControl(OwnedMediaControlMessage(
                        kind: .frameAck,
                        frameId: 0,
                        acknowledgedLtrTokens: [token]
                    ))
                    // The client half of the ADR-0090 round trip, recorded so a run can say
                    // WHERE the loop broke rather than only that recovery cost a keyframe.
                    // Paired with the host's `ltr-token-emitted` and `ltr-ack-received`: tokens
                    // emitted but none acknowledged here means the frames are not reaching the
                    // sink, acknowledged here but not received there means the control message
                    // is being lost.
                    ClientDiagnostics.shared.record(
                        type: "mediaLtrAcknowledged",
                        fields: ["token": String(token)],
                        level: .default
                    )
                }
                mediaSink?.setOwnedMediaPresentationSkipHandler { [weak self] bytes in
                    self?.lock.withLock { state in
                        state.presentationSkips += 1
                        state.presentationSkipBytes += max(0, bytes)
                    }
                }
            }
            pathObserver.start(queue: DispatchQueue(label: "\(Config.logSubsystem).link-telemetry"))
            radioObserver.start()
            startLinkHealthReporting()
            // Now that the sink is installed, announce and run the graphics lane.
            startGraphicsReceiveLoop()
            await MainActor.run { [weak mediaSink] in
                mediaSink?.setOwnedMediaStatus(.connected)
            }
        }
    }

    func stop() {
        close()
    }

    func send(_ event: InputChannelEvent) async throws {
        try await QuicSessionStreamIO.send(
            event,
            role: .input,
            on: inputStream
        )
    }

    func sendConfig(_ config: ClientConfig) async throws {
        try await QuicSessionStreamIO.send(config, role: .input, on: inputStream)
    }

    func sendMediaViewerState(_ state: MediaViewerState) async throws {
        try await QuicSessionStreamIO.send(state, role: .input, on: inputStream)
    }

    func sendRevoke() async throws {
        try await QuicSessionStreamIO.send(SessionRevoke(), role: .input, on: inputStream)
    }

    func sendDiagnosticsSummary(_ summary: DiagnosticsSummary) async throws {
        try await QuicSessionStreamIO.send(summary, role: .input, on: inputStream)
    }

    func sendDiagnosticsChunk(_ chunk: DiagnosticsChunk) async throws {
        try await QuicSessionStreamIO.send(chunk, role: .input, on: inputStream)
    }

    func sendDiagnosticsError(_ error: DiagnosticsError) async throws {
        try await QuicSessionStreamIO.send(error, role: .input, on: inputStream)
    }

    func sendRuntimeCheckpoint(_ checkpoint: ClientRuntimeCheckpoint) async throws {
        try await QuicSessionStreamIO.send(checkpoint, role: .input, on: inputStream)
    }

    func sendScreenshotManifest(_ manifest: ClientScreenshotManifest) async throws {
        try await QuicSessionStreamIO.send(manifest, role: .input, on: inputStream)
    }

    func sendScreenshotChunk(_ chunk: ClientScreenshotChunk) async throws {
        try await QuicSessionStreamIO.send(chunk, role: .input, on: inputStream)
    }

    func sendScreenshotError(_ error: ClientScreenshotError) async throws {
        try await QuicSessionStreamIO.send(error, role: .input, on: inputStream)
    }

    // MARK: - Agent-feed subscription sends (carried on the `.agent` role)

    func sendAgentHTTPRequest(_ request: AgentFeedRelayRequest) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentHTTPCancel(_ request: AgentFeedRelayCancel) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentTerminal(_ message: AgentTerminalClientMessage) async throws {
        try await agentStream.send(try Self.agentTerminalFrame(message))
    }

    func sendWorkspaceTerminal(_ message: WorkspaceTerminalClientMessage) async throws {
        try await inputStream.send(try Self.workspaceTerminalFrame(message))
    }

    func sendAgentWindowInputWatch(_ request: AgentWindowInputWatch) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowInputUnwatch(_ request: AgentWindowInputUnwatch) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowInputSync(_ request: AgentWindowInputSync) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowInputRead(_ request: AgentWindowInputRead) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowInputSubmit(_ request: AgentWindowInputSubmit) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowQuestionWatch(_ request: AgentWindowQuestionWatch) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowQuestionUnwatch(_ request: AgentWindowQuestionUnwatch) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    func sendAgentWindowQuestionAction(_ request: AgentWindowQuestionAction) async throws {
        try await QuicSessionStreamIO.send(request, role: .agent, on: agentStream)
    }

    static func agentTerminalFrame(_ message: AgentTerminalClientMessage) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try QuicSessionStreamFrame.encode(
            role: .agent,
            payload: encoder.encode(message)
        )
    }

    static func workspaceTerminalFrame(_ message: WorkspaceTerminalClientMessage) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try QuicSessionStreamFrame.encode(
            role: .input,
            payload: encoder.encode(message)
        )
    }

    func openTerminalPtyClient() async throws -> PtyClient {
        let stream = try await connection.openStream()
        let transport = TerminalQuicPtyTransport(stream: stream)
        try await transport.announce()
        return PtyClient(transport: transport)
    }

    func openWorkspaceTransport() async throws -> WorkspaceTransport {
        let stream = try await connection.openStream()
        let transport = WorkspaceTransport(channel: QuicWorkspaceChannel(stream: stream))
        try await transport.open()
        return transport
    }

    /// Opens the lane the voice models arrive on. Separate from `openVoiceLane`,
    /// which carries live dictation audio a 152MB transfer would stall.
    func openVoiceAssetLane() async throws -> VoiceAssetLaneClient {
        let client = VoiceAssetLaneClient(stream: try await connection.openStream())
        try await client.open()
        return client
    }

    func openVoiceLane(
        delivery: @escaping VoiceLaneClient.Delivery
    ) async throws -> VoiceLaneClient {
        let client = VoiceLaneClient(
            stream: try await connection.openStream(),
            delivery: delivery
        )
        do {
            try await client.open()
            return client
        } catch {
            client.close()
            throw error
        }
    }

    func close() {
        guard lock.withLock({ state in
            if state.closed { return false }
            state.closed = true
            return true
        }) else { return }
        datagramReceiveTask?.cancel()
        inputReceiveTask?.cancel()
        graphicsReceiveTask?.cancel()
        linkHealthTask?.cancel()
        pathObserver.stop()
        radioObserver.stop()
        desktopStateContinuation.finish()
        thumbnailsContinuation.finish()
        topWindowsContinuation.finish()
        windowListContinuation.finish()
        agentSayContinuation.finish()
        agentPanelOriginContinuation.finish()
        cursorContinuation.finish()
        cursorReconciliationContinuation.finish()
        hostAvailabilityContinuation.finish()
        textInputFocusContinuation.finish()
        diagnosticsContinuation.finish()
        screenshotContinuation.finish()
        agentTerminalContinuation.finish()
        workspaceTerminalContinuation.finish()
        closedContinuation.yield(())
        closedContinuation.finish()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
        // Set the code the peer will see, then drop the resources. Releasing is the only
        // teardown this API has, and it must happen here rather than whenever the last task
        // holding the transport happens to finish -- see `Channels`.
        channels.withLock { live in
            live?.connection.applicationError = .init(code: 0, reason: "client-close")
            live = nil
        }
    }

    private func startInputReceiveLoop() {
        inputReceiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: inputStream, expectedRole: .input)
                    guard frame.role == .input else { continue }
                    handleInputPayload(frame.payload)
                } catch {
                    logger.notice("input lane receive ended: \(String(describing: error), privacy: .public)")
                    close()
                    return
                }
            }
        }
    }

    // The Agent panel protocol (.agent role). The client forwards panel-protocol frames verbatim to
    // the webview and intercepts only the handful the native shell must handle (speech, raw-event
    // fragment reassembly, terminal lifecycle), so new agent message types reach the panel without a
    // client-side scatter/allowlist change.
    private func startAgentReceiveLoop() {
        agentReceiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Announce the lane's role with its first frame, exactly like .graphics/.dom: the
                // host's accept loop reads the first frame on the stream purely to learn the role
                // and discards its payload. Without this announce the first real agent request
                // would be consumed as the role probe and the panel would wait forever.
                try await QuicSessionStreamIO.sendPayload(Data([0]), role: .agent, on: agentStream)
                logger.notice("agent lane announced")
            } catch {
                logger.notice("agent lane announce failed: \(String(describing: error), privacy: .public)")
                return
            }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: agentStream, expectedRole: .agent)
                    guard frame.role == .agent else { continue }
                    handleAgentLanePayload(frame.payload)
                } catch {
                    logger.notice("agent lane receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    // ADR-0034 crisp-repair: announce this stream as the graphics lane (one role-tagged
    // frame the host reads to attach its pusher), then read host-pushed ADGC frames and
    // apply each to the sink. The lane is supplementary to the always-live video floor, so
    // a graphics-side failure stops this loop but does not tear down the session; the input
    // loop owns whole-session teardown. A frame the sink cannot apply triggers a graphics
    // reset request to the host so it re-establishes a clean baseline.
    private func startGraphicsReceiveLoop() {
        graphicsReceiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Non-empty announce: the host reads `length` bytes after the role/header,
                // and receive(exactly: 0) is a degenerate read; a 1-byte payload (the host
                // ignores its content) keeps the host's receiveFrame on the normal path.
                try await QuicSessionStreamIO.sendPayload(Data([0]), role: .graphics, on: graphicsStream)
                logger.notice("graphics lane announced")
            } catch {
                logger.notice("graphics lane announce failed: \(String(describing: error), privacy: .public)")
                return
            }
            let headerSize = OwnedGraphicsFrameEnvelope.fixedHeaderByteCount
            while !Task.isCancelled {
                do {
                    let header = try await graphicsStream.receive(exactly: headerSize).content
                    guard header.count == headerSize else { throw OwnedGraphicsTransportError.streamEOF }
                    let bytes = [UInt8](header)
                    guard Array(bytes[0..<4]) == OwnedGraphicsFrameEnvelope.magic,
                          bytes[4] == OwnedGraphicsFrameEnvelope.version else {
                        throw OwnedGraphicsTransportError.frameMalformed
                    }
                    let metadataLength = bytes[5..<9].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                    let payloadLength = bytes[9..<13].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                    // UInt32 lengths widened to Int cannot overflow or go negative on a
                    // 64-bit target; the frame-size cap is the meaningful bound.
                    let bodyLength = Int(metadataLength) + Int(payloadLength)
                    guard headerSize + bodyLength <= OwnedGraphicsStreamFrameParser.maxFrameByteCount else {
                        throw OwnedGraphicsTransportError.frameMalformed
                    }
                    var frameData = header
                    if bodyLength > 0 {
                        let body = try await graphicsStream.receive(exactly: bodyLength).content
                        guard body.count == bodyLength else { throw OwnedGraphicsTransportError.streamEOF }
                        frameData.append(body)
                    }
                    let envelope = try OwnedGraphicsFrameEnvelope.decode(frameData)
                    await applyGraphicsEnvelope(envelope)
                } catch {
                    logger.notice("graphics lane receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    private func applyGraphicsEnvelope(_ envelope: OwnedGraphicsFrameEnvelope) async {
        let resetRequest: OwnedGraphicsResetRequest? = await MainActor.run { [weak self] in
            guard let sink = self?.sink else { return nil }
            _ = sink.renderOwnedGraphicsFrame(envelope, queueDepth: .empty)
            return sink.consumePendingGraphicsResetRequest()
        }
        guard let resetRequest else { return }
        ClientDiagnostics.shared.record(
            type: "graphicsResetRequested",
            fields: [
                "reason": resetRequest.reason,
                "lastCommittedSurfaceGeneration": String(resetRequest.lastCommittedSurfaceGeneration),
                "lastCommittedFrameId": String(resetRequest.lastCommittedFrameId)
            ],
            level: .error
        )
        sendVideoControl(OwnedMediaControlMessage(kind: .graphicsResetRequest, frameId: resetRequest.lastCommittedFrameId))
    }

    /// Read video datagrams for as long as the session lives, surviving transient errors.
    ///
    /// Same defect and same fix as the host's control loop: ending on the first throw made every
    /// transient fault permanent. It matters more here, because this loop stopping is not merely
    /// deafness -- arrivals are the session's main liveness evidence, so a dead receive loop
    /// manufactures exactly the silence the session clock acts on, and the client would end a
    /// session over its own stopped task.
    private func startDatagramReceiveLoop() {
        datagramReceiveTask = Task { [weak self] in
            guard let self else { return }
            var retry = DatagramReceiveRetry()
            let budgetMs = Double(Config.ownedMediaReceiveRetryBudgetMs)
            while !Task.isCancelled {
                // ADR-0088: bumped BEFORE the await, so an iteration that blocks forever in
                // receive() still counts. Counting after would make a wedged receive
                // indistinguishable from a task that never ran, which is the exact
                // distinction this exists to draw.
                lock.withLock { $0.arrivals.noteLoopIteration() }
                do {
                    let message = try await datagrams.receive()
                    let nowNs = DispatchTime.now().uptimeNanoseconds
                    lock.withLock { $0.arrivals.noteArrival(atNs: nowNs) }
                    if let recovered = retry.noteSuccess(nowNs: nowNs) {
                        logger.notice(
                            """
                            video datagram receive recovered \
                            failures=\(recovered.failures, privacy: .public) \
                            outageMs=\(Int(recovered.outageMs), privacy: .public)
                            """
                        )
                        ClientDiagnostics.shared.record(
                            type: "mediaReceiveRecovered",
                            fields: [
                                "failures": String(recovered.failures),
                                "outageMs": String(Int(recovered.outageMs))
                            ]
                        )
                    }
                    handleVideoDatagram(message.content)
                } catch {
                    if Task.isCancelled || error is CancellationError { return }
                    // Edge-triggered, like the control-send health around it: one line when the
                    // run opens, one when it closes.
                    let isFirst = !retry.isFailing
                    let outcome = retry.noteFailure(
                        nowNs: DispatchTime.now().uptimeNanoseconds,
                        budgetMs: budgetMs
                    )
                    if isFirst {
                        logger.notice("video datagram receive failing: \(String(describing: error), privacy: .public)")
                        ClientDiagnostics.shared.record(
                            type: "mediaReceiveFailing",
                            fields: ["reason": String(describing: error)],
                            level: .error
                        )
                    }
                    switch outcome {
                    case .retry(let backoffMs):
                        try? await Task.sleep(nanoseconds: UInt64(backoffMs * 1_000_000))
                    case .giveUp(let failures, let elapsedMs):
                        logger.error(
                            """
                            video datagram receive ended \
                            failures=\(failures, privacy: .public) \
                            elapsedMs=\(Int(elapsedMs), privacy: .public) \
                            last=\(String(describing: error), privacy: .public)
                            """
                        )
                        ClientDiagnostics.shared.record(
                            type: "mediaReceiveEnded",
                            fields: [
                                "failures": String(failures),
                                "elapsedMs": String(Int(elapsedMs)),
                                "reason": String(describing: error)
                            ],
                            level: .error
                        )
                        return
                    }
                }
            }
        }
    }

    private func handleInputPayload(_ data: Data) {
        guard let header = try? JSONDecoder().decode(InputFrameHeader.self, from: data) else {
            return
        }
        // ADR-0104: every decodable input-lane frame is host-originated, so every one is
        // liveness evidence -- an availability push proves the session exactly as well as a
        // pong does. The pong case below only exists for when nothing else is flowing.
        livenessMonitor.withLock { $0 }?.noteEvidence(nowNs: DispatchTime.now().uptimeNanoseconds)
        switch header.type {
        case "session-pong":
            if let pong = try? JSONDecoder().decode(SessionPong.self, from: data),
               pong.sessionId == activeSession.sessionId {
                _ = livenessMonitor.withLock { $0 }?.notePong(
                    sequence: pong.sequence,
                    nowNs: DispatchTime.now().uptimeNanoseconds
                )
            }
        case "desktop-state":
            if let push = try? JSONDecoder().decode(DesktopStatePush.self, from: data) {
                desktopStateContinuation.yield(push.state)
            }
        case "thumbnails-push":
            if let push = try? JSONDecoder().decode(ThumbnailsPush.self, from: data) {
                thumbnailsContinuation.yield(push.thumbnails)
                topWindowsContinuation.yield(push.topWindows ?? [:])
            }
        case "window-list":
            if let push = try? JSONDecoder().decode(WindowListPush.self, from: data) {
                windowListContinuation.yield(push)
            }
        case "cursor":
            if let push = try? JSONDecoder().decode(CursorImagePush.self, from: data) {
                cursorContinuation.yield(push)
            }
        case "cursor-applied":
            if let push = try? JSONDecoder().decode(CursorAppliedPush.self, from: data) {
                cursorReconciliationContinuation.yield(.applied(push))
            }
        case "host-cursor-moved":
            if let push = try? JSONDecoder().decode(HostCursorMovedPush.self, from: data) {
                cursorReconciliationContinuation.yield(.hostMoved(push))
            }
        case "host-availability":
            if let push = try? JSONDecoder().decode(HostAvailabilityPush.self, from: data) {
                hostAvailabilityContinuation.yield(push)
            }
        case "text-input-focus":
            if let push = try? JSONDecoder().decode(HostTextInputFocusPush.self, from: data) {
                textInputFocusContinuation.yield(push)
            }
        case "diagnostics-request":
            if let request = try? JSONDecoder().decode(DiagnosticsRequest.self, from: data) {
                diagnosticsContinuation.yield(.request(request))
            }
        case "client-screenshot-request":
            if let request = try? JSONDecoder().decode(ClientScreenshotRequest.self, from: data) {
                screenshotContinuation.yield(.request(request))
            }
        case "workspace-terminal-ready", "workspace-terminal-error":
            if !Self.dispatchWorkspaceTerminalPayload(data, to: workspaceTerminalContinuation) {
                logger.error("input lane workspace terminal push decode failed")
            }
        case "session-rejected":
            close()
        default:
            logger.debug("input lane ignored frame type=\(header.type, privacy: .public)")
        }
    }

    // The Agent panel protocol (.agent role). The client intercepts only the handful of frames the
    // native shell must handle (speech, terminal lifecycle, and where the panel loads its code from
    // -- the webview cannot be the one to decide that, since it is the thing being reloaded) and
    // forwards every other `agent-*` frame verbatim to the panel webview, which decodes by `t` and
    // ignores anything it does not yet know. New agent message types therefore never need a
    // per-type change here.
    private func handleAgentLanePayload(_ data: Data) {
        guard let header = try? JSONDecoder().decode(InputFrameHeader.self, from: data) else {
            return
        }
        if AgentPanelLaneRouting.nativeInterceptedTypes.contains(header.type) {
            switch header.type {
            case "agent-say":
                if let push = try? JSONDecoder().decode(AgentSayPush.self, from: data) {
                    agentSayContinuation.yield(push)
                }
            case "agent-panel-origin":
                if let push = try? JSONDecoder().decode(AgentPanelOriginPush.self, from: data) {
                    agentPanelOriginContinuation.yield(push)
                } else {
                    logger.error("agent lane panel-origin push decode failed")
                }
            case "agent-terminal-ready", "agent-terminal-ended", "agent-terminal-error":
                if !Self.dispatchAgentTerminalPayload(data, to: agentTerminalContinuation) {
                    logger.error("agent lane agent terminal push decode failed")
                }
            default:
                break
            }
            return
        }
        guard AgentPanelLaneRouting.isPanelProtocol(header.type) else {
            logger.debug("agent lane non-panel frame type=\(header.type, privacy: .public)")
            return
        }
        deliverAgentPush(data)
    }

    private func deliverAgentPush(_ data: Data) {
        guard let json = String(data: data, encoding: .utf8) else {
            logger.error("agent push was not valid UTF-8")
            return
        }
        let closure = onAgentPush
        Task { @MainActor in closure?(json) }
    }

    @discardableResult
    static func dispatchAgentTerminalPayload(
        _ data: Data,
        to continuation: AsyncStream<AgentTerminalHostMessage>.Continuation
    ) -> Bool {
        guard let message = AgentTerminalPushDecoder.decode(data) else { return false }
        continuation.yield(message)
        return true
    }

    @discardableResult
    static func dispatchWorkspaceTerminalPayload(
        _ data: Data,
        to continuation: AsyncStream<WorkspaceTerminalHostMessage>.Continuation
    ) -> Bool {
        guard let message = try? JSONDecoder().decode(WorkspaceTerminalHostMessage.self, from: data) else {
            return false
        }
        continuation.yield(message)
        return true
    }

    private func handleVideoDatagram(_ data: Data) {
        if let control = try? JSONDecoder().decode(SessionRejected.self, from: data),
           control.type == "session-rejected" {
            close()
            return
        }
        guard let packet = try? MediaDatagramFramePacket.decode(data, key: mediaKey) else {
            return
        }
        let nowNs = DispatchTime.now().uptimeNanoseconds
        let handling = lock.withLock { state -> (
            result: MediaDatagramRepairResult,
            decisions: [MediaFrameRecoveryGate.CompletedFrameDecision],
            resolvedArmedNs: UInt64?,
            gateArmed: Bool,
            discardedAtResolve: Int,
            requestKeyframe: MediaFrameRecoveryGate.KeyframeRequest?
        ) in
            let accepted = mediaRepairBuffer.accept(packet)
            state.completedFrames += accepted.completedFrames.count
            state.expiredFrames += accepted.skippedFrames.count
            var gateArmed = false
            if !accepted.skippedFrames.isEmpty {
                gateArmed = state.mediaRecovery.noteGapSkip(nowNs: nowNs)
            }
            // Captured BEFORE the decisions clear it, so a resolve can report how many cheap
            // answers were thrown away on the way to the one that landed.
            let discardedAtResolve = state.mediaRecovery.discardedSinceArmed
            var resolvedArmedNs: UInt64?
            let decisions = accepted.completedFrames.map { completed -> MediaFrameRecoveryGate.CompletedFrameDecision in
                let outcome = state.mediaRecovery.decideCompletedFrame(
                    isKeyframe: completed.isKeyframe,
                    isLtrResync: completed.isLtrResync,
                    nowNs: nowNs
                )
                if let armedNs = outcome.armedNs { resolvedArmedNs = armedNs }
                return outcome.decision
            }
            state.discardedRecoveryDeltas += decisions.filter { $0 == .discardRecoveryDelta }.count
            state.keyframeRecoveries += decisions.filter { $0 == .renderRecoveryKeyframe }.count
            state.resyncRecoveries += decisions.filter { $0 == .renderRecoveryResync }.count
            state.maxPendingFrameDepth = max(state.maxPendingFrameDepth, accepted.pendingFrameCount)
            let requestKeyframe = state.mediaRecovery.takeKeyframeRequestIfNeeded(nowNs: nowNs)
            return (accepted, decisions, resolvedArmedNs, gateArmed, discardedAtResolve, requestKeyframe)
        }
        if handling.gateArmed, let skipped = handling.result.skippedFrames.last {
            // The moment the freeze-risk window opens. Paired with mediaRecoveryResolved below;
            // an armed record with no resolve is the frozen-session signature, and before these
            // existed 857 recovery requests reached the host while the client recorded 3.
            ClientDiagnostics.shared.record(
                type: "mediaRecoveryArmed",
                fields: ["skippedFrameId": String(skipped.frameId)],
                level: .info
            )
        }
        for (completed, decision) in zip(handling.result.completedFrames, handling.decisions) {
            sendVideoControl(OwnedMediaControlMessage(kind: .frameAck, frameId: completed.frameId))
            guard decision != .discardRecoveryDelta else { continue }
            guard let envelope = try? OwnedMediaFrameEnvelope.decode(completed.data) else {
                // Was a silent `continue` folded into the discard guard, and that silence cost
                // an investigation: a frame vanishing here has already been acked, so the host
                // believes it was delivered while the decoder never sees it -- the same
                // reference-chain break as a wholly-lost frame, minus any record of it.
                ClientDiagnostics.shared.record(
                    type: "mediaEnvelopeDecodeFailed",
                    fields: ["frameId": String(completed.frameId), "bytes": String(completed.data.count)],
                    level: .error
                )
                continue
            }
            if decision == .renderRecoveryKeyframe || decision == .renderRecoveryResync {
                ClientDiagnostics.shared.record(
                    type: "mediaRecoveryResolved",
                    fields: [
                        "kind": decision == .renderRecoveryResync ? "ltr-resync" : "keyframe",
                        "frameId": String(completed.frameId),
                        "discardedDeltas": String(handling.discardedAtResolve),
                        "armedMs": String(Int(Double(handling.resolvedArmedNs ?? 0) / 1_000_000))
                    ],
                    level: .info
                )
            }
            ClientRuntimeTelemetry.shared.advanceVideoMilestone(.frameCompleted)
            Task { @MainActor [weak self] in
                self?.sink?.renderOwnedVideoFrame(envelope, frameBytes: completed.data.count)
            }
        }
        for request in handling.result.resendRequests {
            Task { @MainActor [weak self] in
                self?.sink?.noteOwnedMediaRepairRequested(1)
            }
            ClientDiagnostics.shared.record(
                type: "mediaRepairRequested",
                fields: [
                    "frameId": String(request.frameId),
                    "missingPacketCount": String(request.packetIndexes.count)
                ],
                level: .info
            )
            sendVideoControl(OwnedMediaControlMessage(
                kind: .packetResendRequest,
                frameId: request.frameId,
                packetIndexes: request.packetIndexes
            ))
        }
        if let skipped = handling.result.skippedFrames.last {
            let skippedCount = handling.result.skippedFrames.count
            Task { @MainActor [weak self] in
                self?.sink?.noteOwnedMediaDroppedFrames(skippedCount)
            }
            ClientDiagnostics.shared.record(
                type: "mediaGapSkipped",
                fields: [
                    "frameId": String(skipped.frameId),
                    "skippedFrameCount": String(skippedCount)
                ],
                level: .info
            )
        }
        if let request = handling.requestKeyframe {
            let recoveryFrameId = handling.result.skippedFrames.last?.frameId
                ?? handling.result.completedFrames.last?.frameId
                ?? packet.frameId
            if request.declareNoReferences {
                // The backstop firing means the design's cheap path did not resolve the gate:
                // either the resync deltas are not arriving or they are arriving undecodable.
                // Loud, because with resync acceptance in place this should be rare enough
                // that every occurrence deserves a look.
                ClientDiagnostics.shared.record(
                    type: "mediaRecoveryEscalated",
                    fields: ["frameId": String(recoveryFrameId)],
                    level: .error
                )
            }
            sendVideoControl(OwnedMediaControlMessage(
                kind: .keyframeRequest,
                frameId: recoveryFrameId,
                reason: request.declareNoReferences ? "gap-recovery-escalated" : "gap-recovery",
                clientHasNoReferences: request.declareNoReferences ? true : nil
            ))
        }
        if handling.decisions.contains(.renderRecoveryKeyframe) {
            ClientDiagnostics.shared.record(
                type: "mediaKeyframeRecovery",
                fields: ["frameId": String(packet.frameId)],
                level: .info
            )
        }
    }

    private func startLinkHealthReporting() {
        guard linkHealthTask == nil else { return }
        let intervalMs = Config.ownedMediaLinkHealthIntervalMs
        guard intervalMs > 0 else { return }
        linkHealthTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(intervalMs) * 1_000_000)
                self?.flushLinkHealth()
            }
        }
    }

    private func flushLinkHealth() {
        let intervalMs = Config.ownedMediaLinkHealthIntervalMs
        let nowNs = DispatchTime.now().uptimeNanoseconds
        let counts = lock.withLock { state -> (
            completed: Int,
            skipped: Int,
            discardedRecoveryDeltas: Int,
            keyframeRecoveries: Int,
            resyncRecoveries: Int,
            maxPendingFrameDepth: Int,
            arrivals: Int,
            maxArrivalGapMs: Double,
            loopIterations: Int,
            presentationSkips: Int,
            presentationSkipBytes: Int
        ) in
            let arrivals = state.arrivals.drain(nowNs: nowNs)
            let counts = (
                state.completedFrames,
                state.expiredFrames,
                state.discardedRecoveryDeltas,
                state.keyframeRecoveries,
                state.resyncRecoveries,
                state.maxPendingFrameDepth,
                arrivals.arrivals,
                arrivals.maxGapMs,
                arrivals.loopIterations,
                state.presentationSkips,
                state.presentationSkipBytes
            )
            state.completedFrames = 0
            state.expiredFrames = 0
            state.discardedRecoveryDeltas = 0
            state.keyframeRecoveries = 0
            state.resyncRecoveries = 0
            state.maxPendingFrameDepth = 0
            state.presentationSkips = 0
            state.presentationSkipBytes = 0
            return counts
        }
        // Every count below is CUMULATIVE, not per-window. R208: this report is a datagram on
        // the link it describes, so a counter that resets on read is destroyed by the very
        // failure it exists to report. The `new*` values are local-only and gate the console
        // line at the bottom of this function.
        let (pathSnapshot, pathChanges, newPathChanges) = pathObserver.reportSnapshot()
        let (radio, radioChanges, newRadioChanges) = radioObserver.reportSnapshot()
        // Sampled here rather than from the path callback: a cellular address change with no
        // interface change is the case this exists to catch, and it may produce no path
        // callback at all. One getifaddrs per report window is the price of not missing it.
        changeDetector.sampleAddresses()
        let (linkChanges, newLinkChanges, linkChangeCauses) = changeDetector.reportSnapshot()
        // ADR-0104: feed the session's one liveness clock and relay its verdict. This loop
        // forms no opinion of its own -- the two detectors that used to live here (a handover
        // grace timer and an unanswered-datagram counter) each reached verdicts that the
        // other's evidence contradicted, and the session paid for whichever was wrong first.
        if newLinkChanges > 0 {
            // A link change is a reason to ask sooner, never a conclusion. The old grace
            // timer here declared a real handover dead at 2,098ms against a 2,000ms grace.
            logger.notice("link changed, pinging now causes=\(linkChangeCauses ?? "unknown", privacy: .public)")
            pingNow.withLock { $0 = true }
        }
        driveSessionLiveness(arrivals: counts.arrivals, nowNs: nowNs)
        let telemetry = OwnedMediaLinkTelemetry(
            interfaceType: pathSnapshot?.interfaceType,
            expensive: pathSnapshot?.expensive,
            constrained: pathSnapshot?.constrained,
            ultraConstrained: pathSnapshot?.ultraConstrained,
            linkQuality: pathSnapshot?.linkQuality,
            pathStatus: pathSnapshot?.status,
            unsatisfiedReason: pathSnapshot?.unsatisfiedReason,
            pathChanges: pathChanges,
            radioAccess: radio,
            radioChanges: radioChanges,
            datagramsReceived: counts.arrivals,
            maxArrivalGapMs: counts.maxArrivalGapMs,
            receiveLoopIterations: counts.loopIterations,
            presentationSkips: counts.presentationSkips,
            presentationSkipBytes: counts.presentationSkipBytes,
            linkChanges: linkChanges,
            linkChangeCauses: linkChangeCauses
        )

        // ADR-0088: the report goes out unconditionally.
        //
        // This used to return early when all five frame counters were zero, on the reasoning
        // that there was nothing to say. That reasoning stopped being true twice over. First,
        // a zero-count window now carries path, radio, and receive-loop state, which is never
        // "nothing" -- it is the most informative report we send, because it is the one that
        // arrives during a freeze. Second, suppressing it made "the client is stalled" and
        // "the client is gone" identical on the wire, which is precisely the distinction the
        // host needs to respond correctly.
        //
        // The cost is bounded and was measured: across a clean 8-minute session not one
        // report was suppressed, so in healthy operation this adds nothing. Suppression
        // concentrated in the freezes (84 of 94 lost reports in one session), which is
        // exactly where the extra ~2 messages/sec buy the most.
        sendVideoControl(OwnedMediaControlMessage(
            kind: .linkHealth,
            frameId: 0,
            linkHealthCompletedFrames: counts.completed,
            linkHealthExpiredFrames: counts.skipped,
            linkTelemetry: telemetry
        ))

        // The LOCAL record stays gated. It writes to the client console log, which is the log
        // we read during an incident; 2 lines/sec of "nothing happened" would bury the traces
        // we are looking for. A transition or a stalled receive loop still forces a line, so
        // nothing interesting is dropped -- only the genuinely idle windows.
        let receiveLoopStalled = counts.arrivals == 0 && counts.maxArrivalGapMs >= Double(intervalMs)
        guard counts.completed > 0
            || counts.skipped > 0
            || counts.discardedRecoveryDeltas > 0
            || counts.keyframeRecoveries > 0
            || counts.resyncRecoveries > 0
            || counts.maxPendingFrameDepth > 0
            || counts.presentationSkips > 0
            || newPathChanges > 0
            || newRadioChanges > 0
            || newLinkChanges > 0
            || receiveLoopStalled
        else { return }
        ClientDiagnostics.shared.record(
            type: "mediaLinkHealthSummary",
            fields: [
                "completedFrames": String(counts.completed),
                "expiredFrames": String(counts.skipped),
                "gapSkips": String(counts.skipped),
                "discardedRecoveryDeltas": String(counts.discardedRecoveryDeltas),
                "keyframeRecoveries": String(counts.keyframeRecoveries),
                "resyncRecoveries": String(counts.resyncRecoveries),
                "maxPendingFrameDepth": String(counts.maxPendingFrameDepth),
                "telemetry": telemetry.logDescription
            ],
            level: .info
        )
    }

    /// ADR-0104: drive the session's liveness clock from this carrier.
    ///
    /// Three duties, none of them a judgment: report evidence (any datagram arrival counts;
    /// the input lane reports its own frames as they decode), manufacture a ping when the
    /// clock says everything has been quiet, and relay the clock's verdict. The clock itself
    /// lives with the session in `PairingClient`, so the silence it measures spans every
    /// carrier this session has tried -- a redial does not reset it, only evidence does.
    private func driveSessionLiveness(arrivals: Int, nowNs: UInt64) {
        guard let monitor = livenessMonitor.withLock({ $0 }) else { return }
        if arrivals > 0 {
            monitor.noteEvidence(nowNs: nowNs)
        }
        let forced = pingNow.withLock { pending -> Bool in
            defer { pending = false }
            return pending
        }
        if let sequence = forced
            ? monitor.forcedPingSequence(nowNs: nowNs)
            : monitor.pingSequenceIfQuiet(nowNs: nowNs) {
            sendSessionPing(sequence: sequence)
        }
        // A quiet carrier is replaced before the session is judged. Measured: a connection
        // went zombie without the OS ever reporting it failed, so no carrier-lost event
        // fired and the session clock -- the only detector left -- ended a session whose
        // host was answering the whole time. Quiet-despite-pings on a carrier that has had
        // its full grace means swap the carrier; the verdict below is only for silence that
        // survives the swapping. Latched per carrier: this transport is being replaced, so
        // one report is all it gets to give.
        let staleMs = monitor.msSinceEvidence(nowNs: nowNs)
        if SessionCarrierStaleness.isStale(
            msSinceEvidence: staleMs,
            msSinceCarrierStart: Double(nowNs &- carrierStartedNs) / 1_000_000,
            staleLimitMs: Double(Config.sessionCarrierStaleMs)
        ) {
            let firstReport = carrierStaleReported.withLock { reported -> Bool in
                defer { reported = true }
                return !reported
            }
            if firstReport {
                logger.notice("carrier stale, replacing quietMs=\(Int(staleMs), privacy: .public)")
                ClientDiagnostics.shared.record(
                    type: "carrierStale",
                    fields: ["quietMs": String(Int(staleMs))],
                    level: .default
                )
                stateContinuation.yield(.failed(.transportFailed))
            }
            return
        }
        guard let silentMs = monitor.silentVerdict(nowNs: nowNs) else { return }
        logger.notice(
            "session unreachable silentMs=\(Int(silentMs), privacy: .public)"
        )
        ClientDiagnostics.shared.record(
            type: "sessionUnreachable",
            fields: ["silentMs": String(Int(silentMs))],
            level: .error
        )
        stateContinuation.yield(.failed(.unreachable(silentMs: Int(silentMs))))
    }

    /// A framed message on the input lane, like every other control exchange. Not a datagram:
    /// the probe/echo design lost 38% of its replies to the video sharing that flow, and a
    /// lost reply is indistinguishable from a dead host. Not a dedicated stream either: both
    /// dedicated-lane designs made one stream's health stand for the session's.
    private func sendSessionPing(sequence: UInt64) {
        let ping = SessionPing(sessionId: activeSession.sessionId, sequence: sequence)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await QuicSessionStreamIO.send(ping, role: .input, on: inputStream)
            } catch {
                // The carrier is failing; its own error paths report that. The ping's job is
                // done either way: silence keeps accumulating, which is the signal.
                logger.notice("session ping send failed seq=\(sequence, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// Called by `PairingClient` immediately after the dial returns, before `start()`.
    func adoptLivenessMonitor(_ monitor: SessionLivenessMonitor) {
        livenessMonitor.withLock { $0 = monitor }
    }

    /// Send a control message on the datagram lane.
    ///
    /// This used to swallow both failure paths with `try?`, and that silence cost a device run.
    /// R208 measured a handover where the client detected the link change correctly and the
    /// host never learned of it, because the report describing the link went out as a datagram
    /// **over that same link** and was dropped. Nothing anywhere said so. The loss had to be
    /// inferred afterwards from a 76x concentration of missing report windows.
    ///
    /// Reporting it is not as simple as logging each failure: `frameAck` comes through here
    /// once per frame, so a failing link would emit tens of lines a second and bury the freeze
    /// in the log written to diagnose it. So this is edge-triggered like the observers around
    /// it -- one line when sends begin failing, one when they resume carrying how many were
    /// lost and for how long. That is the shape you actually read during an incident.
    private func sendVideoControl(_ message: OwnedMediaControlMessage) {
        Task { [weak self] in
            let kind = message.kind.rawValue
            guard let data = try? JSONEncoder().encode(message) else {
                // Encoding a fixed Codable shape cannot fail for data reasons, so this is a
                // programming error rather than a link problem. Named separately so it is not
                // read as network loss.
                self?.noteControlSendFailure(kind: kind, reason: "encode")
                return
            }
            do {
                // Read through the accessor rather than a capture: a control send racing a
                // close must fail, not resurrect the connection it is sending on.
                guard let datagrams = try? self?.datagrams else { return }
                try await datagrams.send(data)
                self?.noteControlSendRecovered()
            } catch {
                self?.noteControlSendFailure(kind: kind, reason: String(describing: error))
            }
        }
    }

    private func noteControlSendFailure(kind: String, reason: String) {
        let isFirst = controlSendHealth.withLock { health -> Bool in
            health.failures += 1
            guard health.failures == 1 else { return false }
            health.firstFailureUptimeNs = DispatchTime.now().uptimeNanoseconds
            return true
        }
        guard isFirst else { return }
        logger.notice(
            "control send failing kind=\(kind, privacy: .public) reason=\(reason, privacy: .public)"
        )
        ClientDiagnostics.shared.record(
            type: "mediaControlSendFailing",
            fields: ["kind": kind, "reason": reason],
            level: .error
        )
    }

    private func noteControlSendRecovered() {
        let recovered = controlSendHealth.withLock { health -> (failures: Int, sinceNs: UInt64)? in
            guard health.failures > 0 else { return nil }
            let started = health.firstFailureUptimeNs
            let now = DispatchTime.now().uptimeNanoseconds
            let result = (health.failures, started.map { now >= $0 ? now - $0 : 0 } ?? 0)
            health.failures = 0
            health.firstFailureUptimeNs = nil
            return result
        }
        guard let recovered else { return }
        let outageMs = Double(recovered.sinceNs) / 1_000_000
        logger.notice(
            "control send recovered lost=\(recovered.failures, privacy: .public) outageMs=\(Int(outageMs), privacy: .public)"
        )
        ClientDiagnostics.shared.record(
            type: "mediaControlSendRecovered",
            fields: [
                "lostMessages": String(recovered.failures),
                "outageMs": String(Int(outageMs))
            ],
            level: .info
        )
    }

    private func handleConnectionState(_ state: NetworkChannel<QUIC>.State) {
        logger.notice("session quic state=\(String(describing: state), privacy: .public)")
        ClientDiagnostics.shared.record(
            type: "sessionTransportState",
            fields: ["state": String(describing: state)],
            level: .info
        )
        switch state {
        case .ready:
            stateContinuation.yield(.connected)
        case .waiting:
            stateContinuation.yield(.disconnected)
        case .failed:
            stateContinuation.yield(.failed(.transportFailed))
            close()
        case .cancelled:
            close()
        default:
            break
        }
    }

    /// Counts a run of failed control sends so the pair of log lines can report the whole
    /// outage rather than its first millisecond.
    private struct ControlSendHealth {
        var failures: Int = 0
        var firstFailureUptimeNs: UInt64?
    }

    private struct State {
        var closed = false
        var completedFrames = 0
        var expiredFrames = 0
        var discardedRecoveryDeltas = 0
        var keyframeRecoveries = 0
        // The cheap half of the recovery split: gates resolved by a marked LTR-resync delta
        // rather than a keyframe. Healthy sessions grow this and not keyframeRecoveries.
        var resyncRecoveries = 0
        var maxPendingFrameDepth = 0
        var mediaRecovery = MediaFrameRecoveryGate(
            keyframeRequestMinGapNs: UInt64(Config.ownedMediaKeyframeRequestMinGapMs) * 1_000_000,
            escalationNs: UInt64(Config.ownedMediaRecoveryEscalationMs) * 1_000_000
        )
        // ADR-0088: receive-loop liveness. Lives in the same lock as the frame counters so a
        // report is one consistent snapshot of the window rather than two racing ones.
        var arrivals = DatagramArrivalTracker()
        // ADR-0088: frames decoded but never shown, pushed here by the sink. Same lock, same
        // window, so the waste is attributable to the window that produced it.
        var presentationSkips = 0
        var presentationSkipBytes = 0
    }

    private struct InputFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}
