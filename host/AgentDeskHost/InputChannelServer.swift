import Foundation
import Network
import os
import AgentDeskWire

enum DiagnosticsChannelUpdate: Equatable, Sendable {
    case summary(DiagnosticsSummary)
    case chunk(DiagnosticsChunk)
    case error(DiagnosticsError)
}

// Agent-feed request message routed to the caller via agentRequestHandler.
enum AgentFeedRequest: Sendable {
    case projectsSubscribe(AgentProjectsSubscribe)
    case threadSubscribe(AgentThreadSubscribe)
    case threadLoadOlder(AgentThreadLoadOlder)
    case threadUnsubscribe(AgentThreadUnsubscribe)
}

protocol InputChannelServing: AnyObject, Sendable {
    var events: AsyncStream<NormalizedInput> { get }
    var diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate> { get }
    var configHandler: ((ClientConfig) -> Void)? { get set }
    // Called on each decoded agent-feed request from the client.
    var agentRequestHandler: ((AgentFeedRequest) -> Void)? { get set }
    // Fired once when the peer drops the input lane (receive loop ends without
    // us cancelling it). QUIC connection-state updates do not reliably fire on a
    // half-dead socket, so lane death is the host's disconnect signal; the owner
    // uses it to suspend the session and stop the stale-send flood.
    var onClosed: (() -> Void)? { get set }
    // Fired when the client sends an explicit revoke frame (settings "Unpair").
    // The owner removes the paired-device record so both sides forget each other.
    var revokeHandler: (() -> Void)? { get set }

    func close()
    func pushDesktopState(_ state: DesktopState)
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow])
    func pushAgentSay(_ push: AgentSayPush)
    func pushCursor(_ push: CursorImagePush)
    func pushCursorPosition(_ push: CursorPositionPush)
    func pushDiagnosticsRequest(_ request: DiagnosticsRequest)
    func pushAgentData(_ data: Data)
}

@available(macOS 26.0, *)
final class InputChannelServer: InputChannelServing, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "input-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private var continuation: AsyncStream<NormalizedInput>.Continuation?
    private var diagnosticsContinuation: AsyncStream<DiagnosticsChannelUpdate>.Continuation?
    private var receiveTask: Task<Void, Never>?

    let events: AsyncStream<NormalizedInput>
    let diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate>
    var configHandler: ((ClientConfig) -> Void)?
    var agentRequestHandler: ((AgentFeedRequest) -> Void)?
    var onClosed: (() -> Void)?
    var revokeHandler: (() -> Void)?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
        var captured: AsyncStream<NormalizedInput>.Continuation?
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
        continuation?.finish()
        continuation = nil
        diagnosticsContinuation?.finish()
        diagnosticsContinuation = nil
        configHandler = nil
        agentRequestHandler = nil
        onClosed = nil
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

    func pushCursorPosition(_ push: CursorPositionPush) {
        sendCodableFrame(push)
    }

    func pushDiagnosticsRequest(_ request: DiagnosticsRequest) {
        sendCodableFrame(request)
    }

    func pushAgentData(_ data: Data) {
        Task { [stream, logger] in
            do {
                try await QuicSessionStreamIO.sendPayload(data, role: .input, on: stream)
            } catch {
                logger.error("input lane agent push send failed: \(String(describing: error), privacy: .public)")
            }
        }
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
        Task { [stream, logger, payload] in
            do {
                try await QuicSessionStreamIO.sendPayload(payload, role: .input, on: stream)
            } catch {
                logger.error("input lane send failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func startReceiveLoop() {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
                    guard frame.role == .input else { continue }
                    dispatch(data: frame.payload)
                } catch {
                    logger.notice("input lane receive ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
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
        switch header.type {
        case "input-event":
            do {
                let frame = try JSONDecoder().decode(InputChannelEvent.self, from: data)
                continuation?.yield(frame.event)
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
        default:
            logger.notice("input lane unknown frame type=\(header.type, privacy: .public)")
        }
    }

    private struct InboundFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}
