import Foundation
import Network
import os
import AgentDeskWire

enum DiagnosticsChannelUpdate: Equatable, Sendable {
    case summary(DiagnosticsSummary)
    case chunk(DiagnosticsChunk)
    case error(DiagnosticsError)
}

// Agent request message routed to the caller via agentRequestHandler.
enum AgentFeedRequest: Sendable {
    case projectsSubscribe(AgentProjectsSubscribe)
    case threadSubscribe(AgentThreadSubscribe)
    case threadLoadOlder(AgentThreadLoadOlder)
    case threadUnsubscribe(AgentThreadUnsubscribe)
    case rawEvent(AgentRawEventRequest)
    case terminal(AgentTerminalClientMessage)
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
    var configHandler: ((ClientConfig) -> Void)? { get set }
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
    func pushAgentSay(_ push: AgentSayPush)
    func pushCursor(_ push: CursorImagePush)
    func pushCursorApplied(_ push: CursorAppliedPush)
    func pushHostCursorMoved(displayId: String?, cursorX: Float, cursorY: Float)
    func pushHostAvailability(_ push: HostAvailabilityPush)
    func pushTextInputFocus(_ push: HostTextInputFocusPush)
    func pushDiagnosticsRequest(_ request: DiagnosticsRequest)
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
    private var receiveTask: Task<Void, Never>?
    // Every host -> client frame on this QUIC stream shares one byte lane.
    // Synchronous enqueue under the lock preserves producer call order; each
    // async write then waits for its predecessor so frames cannot interleave
    // or overtake cursor causality feedback (ADR-0030, ADR-0058).
    private let sendChain = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

    let events: AsyncStream<InputChannelEvent>
    let diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate>
    var configHandler: ((ClientConfig) -> Void)?
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
        configHandler = nil
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
        case "agent-projects-sub":
            logger.notice("input lane agent-projects-sub received fp=\(self.fingerprint.rawValue, privacy: .public)")
            if let msg = try? JSONDecoder().decode(AgentProjectsSubscribe.self, from: data) {
                agentRequestHandler?(.projectsSubscribe(msg))
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
