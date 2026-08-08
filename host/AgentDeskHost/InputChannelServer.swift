import Foundation
import Network
import os
import AgentDeskWire

enum DiagnosticsChannelUpdate: Equatable, Sendable {
    case summary(DiagnosticsSummary)
    case chunk(DiagnosticsChunk)
    case error(DiagnosticsError)
}

enum ClientScreenshotChannelUpdate: Equatable, Sendable {
    case manifest(ClientScreenshotManifest)
    case chunk(ClientScreenshotChunk)
    case error(ClientScreenshotError)
}

// Agent request message routed to the caller via agentRequestHandler.
enum AgentFeedRequest: Sendable {
    case projectsWatch(AgentProjectsWatch)
    case projectsUnwatch(AgentProjectsUnwatch)
    case projectSessionsWatch(AgentProjectSessionsWatch)
    case projectSessionsUnwatch(AgentProjectSessionsUnwatch)
    case threadSubscribe(AgentThreadSubscribe)
    case threadLoadOlder(AgentThreadLoadOlder)
    case threadUnsubscribe(AgentThreadUnsubscribe)
    case rawEvent(AgentRawEventRequest)
    case sessionCreate(AgentSessionCreate)
    case sessionSend(AgentSessionSend)
    case sessionAbort(AgentSessionAbort)
    case extensionUIResponse(AgentExtensionUIResponse)
    case terminal(AgentTerminalClientMessage)
    // Claude Desktop composer sync. Carried on this lane like any other panel request, but answered by
    // the host's own Accessibility path rather than the sidecar, so the caller routes these past the
    // agent-feed bridge entirely.
    case windowInputWatch(AgentWindowInputWatch)
    case windowInputUnwatch(AgentWindowInputUnwatch)
    case windowInputSync(AgentWindowInputSync)
    case windowInputRead(AgentWindowInputRead)
    case windowInputSubmit(AgentWindowInputSubmit)
    // Claude Desktop AskUserQuestion mirror. Same host-local Accessibility path as the composer frames:
    // the mirror's content comes from the transcript feed, and these only watch and actuate the live
    // panel in the window.
    case questionWatch(AgentWindowQuestionWatch)
    case questionUnwatch(AgentWindowQuestionUnwatch)
    case questionAction(AgentWindowQuestionAction)
}

protocol AgentDataPushing: AnyObject, Sendable {
    func pushAgentData(_ data: Data)
}

extension AgentDataPushing {
    func pushAgentTerminal(_ message: AgentTerminalHostMessage) {
        do {
            pushAgentData(try JSONEncoder().encode(message))
        } catch {
            preconditionFailure("Agent terminal host message must encode: \(error)")
        }
    }

    func pushWorkspaceTerminal(_ message: WorkspaceTerminalHostMessage) {
        do {
            pushAgentData(try JSONEncoder().encode(message))
        } catch {
            preconditionFailure("Workspace terminal host message must encode: \(error)")
        }
    }
}

protocol InputChannelServing: AgentDataPushing {
    var events: AsyncStream<InputChannelEvent> { get }
    var diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate> { get }
    var screenshotUpdates: AsyncStream<ClientScreenshotChannelUpdate> { get }
    var configHandler: ((ClientConfig) -> Void)? { get set }
    // Called when the client covers or uncovers the video with a full-screen surface.
    var mediaViewerHandler: ((MediaViewerState) -> Void)? { get set }
    var runtimeCheckpointHandler: ((ClientRuntimeCheckpoint) -> Void)? { get set }
    // Called on each decoded agent-feed request from the client.
    var agentRequestHandler: ((AgentFeedRequest) -> Void)? { get set }
    var workspaceTerminalRequestHandler: ((WorkspaceTerminalClientMessage) -> Void)? { get set }
    // Fired once when the peer drops the input lane (receive loop ends without
    // us cancelling it). QUIC connection-state updates do not reliably fire on a
    // half-dead socket, so lane death is the host's disconnect signal; the owner
    // uses it to suspend the session and stop the stale-send flood.
    var onClosed: (() -> Void)? { get set }
    var receiveErrorPreservationHandler: (@Sendable (Error) async -> Bool)? { get set }
    // Fired when the client sends an explicit revoke frame (settings "Unpair").
    // The owner removes the paired-device record so both sides forget each other.
    var revokeHandler: (() -> Void)? { get set }

    func close()
    func pushDesktopState(_ state: DesktopState)
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow])
    // `icons` is the full hash -> base64 PNG map for `windows`; the implementation drops
    // the ones this client has already been sent.
    func pushWindowList(_ windows: [WindowSummary], icons: [String: String])
    func pushAgentSay(_ push: AgentSayPush)
    func pushCursor(_ push: CursorImagePush)
    func pushCursorApplied(_ push: CursorAppliedPush)
    func pushHostCursorMoved(displayId: String?, cursorX: Float, cursorY: Float)
    func pushHostAvailability(_ push: HostAvailabilityPush)
    func pushTextInputFocus(_ push: HostTextInputFocusPush)
    func pushDiagnosticsRequest(_ request: DiagnosticsRequest)
    func pushScreenshotRequest(_ request: ClientScreenshotRequest)
}

@available(macOS 26.0, *)
final class InputChannelServer: InputChannelServing, @unchecked Sendable {
    private static let agentTerminalRequestTypes: Set<String> = [
        "agent-terminal-open",
        "agent-terminal-attached",
        "agent-terminal-close",
    ]
    private static let workspaceTerminalRequestTypes: Set<String> = [
        "workspace-terminal-open",
        "workspace-terminal-attached",
        "workspace-terminal-cancel",
    ]

    private let logger = Logger(subsystem: Config.logSubsystem, category: "input-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private var continuation: AsyncStream<InputChannelEvent>.Continuation?
    private var diagnosticsContinuation: AsyncStream<DiagnosticsChannelUpdate>.Continuation?
    private var screenshotContinuation: AsyncStream<ClientScreenshotChannelUpdate>.Continuation?
    private var receiveTask: Task<Void, Never>?
    // Every host -> client frame on this QUIC stream shares one byte lane.
    // Synchronous enqueue under the lock preserves producer call order; each
    // async write then waits for its predecessor so frames cannot interleave
    // or overtake cursor causality feedback (ADR-0030, ADR-0058).
    private let sendChain = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)
    private let sentIconHashes = OSAllocatedUnfairLock(initialState: Set<String>())

    let events: AsyncStream<InputChannelEvent>
    let diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate>
    let screenshotUpdates: AsyncStream<ClientScreenshotChannelUpdate>
    var configHandler: ((ClientConfig) -> Void)?
    var mediaViewerHandler: ((MediaViewerState) -> Void)?
    var runtimeCheckpointHandler: ((ClientRuntimeCheckpoint) -> Void)?
    var agentRequestHandler: ((AgentFeedRequest) -> Void)?
    var workspaceTerminalRequestHandler: ((WorkspaceTerminalClientMessage) -> Void)?
    var onClosed: (() -> Void)?
    var receiveErrorPreservationHandler: (@Sendable (Error) async -> Bool)?
    var revokeHandler: (() -> Void)?
    private let cursorRevisionLock = NSLock()
    private var lastAppliedCursorRevision: UInt64?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
        var captured: AsyncStream<InputChannelEvent>.Continuation?
        events = AsyncStream { continuation in
            captured = continuation
        }
        continuation = captured
        var capturedDiagnostics: AsyncStream<DiagnosticsChannelUpdate>.Continuation?
        diagnosticsUpdates = AsyncStream { continuation in
            capturedDiagnostics = continuation
        }
        diagnosticsContinuation = capturedDiagnostics
        var capturedScreenshots: AsyncStream<ClientScreenshotChannelUpdate>.Continuation?
        screenshotUpdates = AsyncStream(bufferingPolicy: .bufferingNewest(20)) { continuation in
            capturedScreenshots = continuation
        }
        screenshotContinuation = capturedScreenshots
        startReceiveLoop()
    }

    func close() {
        receiveTask?.cancel()
        receiveTask = nil
        sendChain.withLock { tail in
            tail?.cancel()
            tail = nil
        }
        continuation?.finish()
        continuation = nil
        diagnosticsContinuation?.finish()
        diagnosticsContinuation = nil
        screenshotContinuation?.finish()
        screenshotContinuation = nil
        configHandler = nil
        mediaViewerHandler = nil
        runtimeCheckpointHandler = nil
        agentRequestHandler = nil
        workspaceTerminalRequestHandler = nil
        onClosed = nil
        receiveErrorPreservationHandler = nil
        revokeHandler = nil
    }

    func pushDesktopState(_ state: DesktopState) {
        sendCodableFrame(DesktopStatePush(state: state))
    }

    func pushAgentSay(_ push: AgentSayPush) {
        sendCodableFrame(push)
    }

    func pushCursor(_ push: CursorImagePush) {
        sendCodableFrame(push)
    }

    func pushCursorApplied(_ push: CursorAppliedPush) {
        cursorRevisionLock.lock()
        lastAppliedCursorRevision = max(lastAppliedCursorRevision ?? 0, push.cursorRevision)
        cursorRevisionLock.unlock()
        sendCodableFrame(push)
    }

    func pushHostCursorMoved(displayId: String?, cursorX: Float, cursorY: Float) {
        cursorRevisionLock.lock()
        let afterCursorRevision = lastAppliedCursorRevision
        cursorRevisionLock.unlock()
        sendCodableFrame(HostCursorMovedPush(
            afterCursorRevision: afterCursorRevision,
            displayId: displayId,
            cursorX: cursorX,
            cursorY: cursorY
        ))
    }

    func pushHostAvailability(_ push: HostAvailabilityPush) {
        sendCodableFrame(push)
    }

    func pushTextInputFocus(_ push: HostTextInputFocusPush) {
        sendCodableFrame(push)
    }

    func pushDiagnosticsRequest(_ request: DiagnosticsRequest) {
        sendCodableFrame(request)
    }

    func pushScreenshotRequest(_ request: ClientScreenshotRequest) {
        sendCodableFrame(request)
    }

    func pushAgentData(_ data: Data) {
        enqueuePayload(data)
    }

    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow] = [:]) {
        logger.notice("thumbnails push fp=\(self.fingerprint.rawValue, privacy: .public) thumbnails=\(thumbnails.count, privacy: .public) topWindows=\(topWindows.count, privacy: .public) ids=\(thumbnails.keys.map { String($0) }.sorted().joined(separator: ","), privacy: .public)")
        var stringKeyed: [String: String] = [:]
        stringKeyed.reserveCapacity(thumbnails.count)
        for (spaceId, jpeg) in thumbnails {
            stringKeyed[String(spaceId)] = jpeg.base64EncodedString()
        }
        var topWindowsKeyed: [String: SpaceTopWindow] = [:]
        topWindowsKeyed.reserveCapacity(topWindows.count)
        for (spaceId, info) in topWindows {
            topWindowsKeyed[String(spaceId)] = info
        }
        sendCodableFrame(ThumbnailsPush(
            thumbnails: stringKeyed,
            topWindows: topWindowsKeyed.isEmpty ? nil : topWindowsKeyed
        ))
    }

    // App icons are per-app and immutable for the life of this lane, so a client pays for
    // each one once. A picker refresh after that carries metadata only.
    func pushWindowList(_ windows: [WindowSummary], icons: [String: String]) {
        let fresh = sentIconHashes.withLock { sent -> [WindowAppIcon] in
            var out: [WindowAppIcon] = []
            for (hash, png) in icons where !sent.contains(hash) {
                sent.insert(hash)
                out.append(WindowAppIcon(hash: hash, png: png))
            }
            return out
        }
        logger.notice("window list push fp=\(self.fingerprint.rawValue, privacy: .public) windows=\(windows.count, privacy: .public) newIcons=\(fresh.count, privacy: .public)")
        sendCodableFrame(WindowListPush(windows: windows, icons: fresh))
    }

    private func sendCodableFrame<T: Encodable>(_ frame: T) {
        let payload: Data
        do {
            payload = try JSONEncoder().encode(frame)
        } catch {
            logger.error("input lane encode failed: \(String(describing: error), privacy: .public)")
            return
        }
        enqueuePayload(payload)
    }

    private func enqueuePayload(_ payload: Data) {
        sendChain.withLock { tail in
            let prior = tail
            tail = Task { [stream, logger, payload] in
                _ = await prior?.value
                guard !Task.isCancelled else { return }
                do {
                    try await QuicSessionStreamIO.sendPayload(payload, role: .input, on: stream)
                } catch {
                    logger.error("input lane send failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    private func startReceiveLoop() {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .input)
                    guard frame.role == .input else { continue }
                    dispatch(data: frame.payload)
                } catch {
                    logger.notice("input lane receive ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
                    let shouldPreserve: Bool
                    if let receiveErrorPreservationHandler {
                        shouldPreserve = await receiveErrorPreservationHandler(error)
                    } else {
                        shouldPreserve = false
                    }
                    if !Task.isCancelled, shouldPreserve {
                        logger.notice("input lane receive error preserved during host availability transition fp=\(self.fingerprint.rawValue, privacy: .public)")
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        continue
                    }
                    // Only a peer-driven drop is a disconnect. A cancelled receive
                    // loop means the owner called close() (session teardown or a
                    // newer lane superseding this one), so it must NOT re-enter the
                    // session-end path. Capture onClosed before close() nils it.
                    let notify = Task.isCancelled ? nil : onClosed
                    close()
                    notify?()
                    return
                }
            }
        }
    }

    private func dispatch(data: Data) {
        guard let header = try? JSONDecoder().decode(InboundFrameHeader.self, from: data) else {
            logger.error("input lane frame missing type discriminator")
            return
        }
        if Self.agentTerminalRequestTypes.contains(header.type) {
            if !Self.dispatchAgentTerminal(
                data: data,
                handler: agentRequestHandler
            ) {
                logger.error("agent terminal request decode failed")
            }
            return
        }
        if Self.workspaceTerminalRequestTypes.contains(header.type) {
            if !Self.dispatchWorkspaceTerminal(
                data: data,
                handler: workspaceTerminalRequestHandler
            ) {
                logger.error("workspace terminal request decode failed")
            }
            return
        }
        switch header.type {
        case "input-event":
            do {
                let frame = try JSONDecoder().decode(InputChannelEvent.self, from: data)
                continuation?.yield(frame)
            } catch {
                logger.error("input lane event decode failed: \(String(describing: error), privacy: .public)")
            }
        case "revoke":
            logger.notice("input lane revoke received fp=\(self.fingerprint.rawValue, privacy: .public)")
            revokeHandler?()
        case "client-config":
            do {
                let frame = try JSONDecoder().decode(ClientConfig.self, from: data)
                logger.notice("client-config received fp=\(self.fingerprint.rawValue, privacy: .public) thumbnails=\(frame.thumbnailsEnabled, privacy: .public) refresh=\(String(describing: frame.thumbnailRefresh), privacy: .public) selectedDisplay=\(frame.selectedDisplayId ?? "nil", privacy: .public)")
                configHandler?(frame)
            } catch {
                logger.error("client-config decode failed: \(String(describing: error), privacy: .public)")
            }
        case "media-viewer":
            do {
                let frame = try JSONDecoder().decode(MediaViewerState.self, from: data)
                mediaViewerHandler?(frame)
            } catch {
                logger.error("media-viewer decode failed: \(String(describing: error), privacy: .public)")
            }
        case "diagnostics-summary":
            if let summary = try? JSONDecoder().decode(DiagnosticsSummary.self, from: data) {
                diagnosticsContinuation?.yield(.summary(summary))
            } else {
                logger.error("diagnostics-summary decode failed")
            }
        case "diagnostics-chunk":
            if let chunk = try? JSONDecoder().decode(DiagnosticsChunk.self, from: data) {
                diagnosticsContinuation?.yield(.chunk(chunk))
            } else {
                logger.error("diagnostics-chunk decode failed")
            }
        case "diagnostics-error":
            if let frame = try? JSONDecoder().decode(DiagnosticsError.self, from: data) {
                diagnosticsContinuation?.yield(.error(frame))
            } else {
                logger.error("diagnostics-error decode failed")
            }
        case "client-runtime-checkpoint":
            if let checkpoint = try? JSONDecoder().decode(ClientRuntimeCheckpoint.self, from: data) {
                runtimeCheckpointHandler?(checkpoint)
            } else {
                logger.error("client-runtime-checkpoint decode failed")
            }
        case "client-screenshot-manifest":
            if let frame = try? JSONDecoder().decode(ClientScreenshotManifest.self, from: data) {
                screenshotContinuation?.yield(.manifest(frame))
            } else {
                logger.error("client-screenshot-manifest decode failed")
            }
        case "client-screenshot-chunk":
            if let frame = try? JSONDecoder().decode(ClientScreenshotChunk.self, from: data) {
                screenshotContinuation?.yield(.chunk(frame))
            } else {
                logger.error("client-screenshot-chunk decode failed")
            }
        case "client-screenshot-error":
            if let frame = try? JSONDecoder().decode(ClientScreenshotError.self, from: data) {
                screenshotContinuation?.yield(.error(frame))
            } else {
                logger.error("client-screenshot-error decode failed")
            }
        case "agent-projects-watch":
            if let msg = try? JSONDecoder().decode(AgentProjectsWatch.self, from: data) {
                agentRequestHandler?(.projectsWatch(msg))
            }
        case "agent-projects-unwatch":
            if let msg = try? JSONDecoder().decode(AgentProjectsUnwatch.self, from: data) {
                agentRequestHandler?(.projectsUnwatch(msg))
            }
        case "agent-project-sessions-watch":
            if let msg = try? JSONDecoder().decode(AgentProjectSessionsWatch.self, from: data) {
                agentRequestHandler?(.projectSessionsWatch(msg))
            }
        case "agent-project-sessions-unwatch":
            if let msg = try? JSONDecoder().decode(AgentProjectSessionsUnwatch.self, from: data) {
                agentRequestHandler?(.projectSessionsUnwatch(msg))
            }
        case "agent-thread-sub":
            logger.debug("input lane agent-thread-sub received fp=\(self.fingerprint.rawValue, privacy: .public)")
            if let msg = try? JSONDecoder().decode(AgentThreadSubscribe.self, from: data) {
                agentRequestHandler?(.threadSubscribe(msg))
            }
        case "agent-thread-older":
            logger.debug("input lane agent-thread-older received fp=\(self.fingerprint.rawValue, privacy: .public)")
            if let msg = try? JSONDecoder().decode(AgentThreadLoadOlder.self, from: data) {
                agentRequestHandler?(.threadLoadOlder(msg))
            }
        case "agent-thread-unsub":
            logger.debug("input lane agent-thread-unsub received fp=\(self.fingerprint.rawValue, privacy: .public)")
            if let msg = try? JSONDecoder().decode(AgentThreadUnsubscribe.self, from: data) {
                agentRequestHandler?(.threadUnsubscribe(msg))
            }
        case "agent-raw-event-get":
            logger.debug("input lane agent-raw-event-get received fp=\(self.fingerprint.rawValue, privacy: .public)")
            if let msg = try? JSONDecoder().decode(AgentRawEventRequest.self, from: data) {
                agentRequestHandler?(.rawEvent(msg))
            }
        case "agent-session-create":
            if let msg = try? JSONDecoder().decode(AgentSessionCreate.self, from: data) {
                agentRequestHandler?(.sessionCreate(msg))
            }
        case "agent-session-send":
            if let msg = try? JSONDecoder().decode(AgentSessionSend.self, from: data) {
                agentRequestHandler?(.sessionSend(msg))
            }
        case "agent-session-abort":
            if let msg = try? JSONDecoder().decode(AgentSessionAbort.self, from: data) {
                agentRequestHandler?(.sessionAbort(msg))
            }
        case "agent-extension-ui-response":
            if let msg = try? JSONDecoder().decode(AgentExtensionUIResponse.self, from: data) {
                agentRequestHandler?(.extensionUIResponse(msg))
            }
        case "agent-window-input-watch":
            if let msg = try? JSONDecoder().decode(AgentWindowInputWatch.self, from: data) {
                agentRequestHandler?(.windowInputWatch(msg))
            }
        case "agent-window-input-unwatch":
            if let msg = try? JSONDecoder().decode(AgentWindowInputUnwatch.self, from: data) {
                agentRequestHandler?(.windowInputUnwatch(msg))
            }
        case "agent-window-input-sync":
            if let msg = try? JSONDecoder().decode(AgentWindowInputSync.self, from: data) {
                agentRequestHandler?(.windowInputSync(msg))
            }
        case "agent-window-input-read":
            if let msg = try? JSONDecoder().decode(AgentWindowInputRead.self, from: data) {
                agentRequestHandler?(.windowInputRead(msg))
            }
        case "agent-window-input-submit":
            if let msg = try? JSONDecoder().decode(AgentWindowInputSubmit.self, from: data) {
                agentRequestHandler?(.windowInputSubmit(msg))
            }
        case "agent-window-question-watch":
            if let msg = try? JSONDecoder().decode(AgentWindowQuestionWatch.self, from: data) {
                agentRequestHandler?(.questionWatch(msg))
            }
        case "agent-window-question-unwatch":
            if let msg = try? JSONDecoder().decode(AgentWindowQuestionUnwatch.self, from: data) {
                agentRequestHandler?(.questionUnwatch(msg))
            }
        case "agent-window-question-action":
            if let msg = try? JSONDecoder().decode(AgentWindowQuestionAction.self, from: data) {
                agentRequestHandler?(.questionAction(msg))
            }
        default:
            logger.notice("input lane unknown frame type=\(header.type, privacy: .public)")
        }
    }

    @discardableResult
    static func dispatchAgentTerminal(
        data: Data,
        handler: ((AgentFeedRequest) -> Void)?
    ) -> Bool {
        guard let message = try? JSONDecoder().decode(AgentTerminalClientMessage.self, from: data) else {
            return false
        }
        handler?(.terminal(message))
        return true
    }

    @discardableResult
    static func dispatchWorkspaceTerminal(
        data: Data,
        handler: ((WorkspaceTerminalClientMessage) -> Void)?
    ) -> Bool {
        guard let message = try? JSONDecoder().decode(WorkspaceTerminalClientMessage.self, from: data) else {
            return false
        }
        handler?(message)
        return true
    }

    private struct InboundFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}
