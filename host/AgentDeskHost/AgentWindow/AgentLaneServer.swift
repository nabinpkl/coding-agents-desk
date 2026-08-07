import Foundation
import Network
import os
import AgentDeskWire

/// The Agent panel protocol lanes, now carried on their own QUIC role (`.agent`).
///
/// Before B, every agent feed/composer/raw-event/terminal/speech frame was multiplexed onto the
/// shared `input` role (role 2) beside native control frames, and each app had to decide "webview
/// vs native" by hand onto a hand-maintained tag allowlist in `handleInputPayload`. A dedicated
/// role lets the client forward the panel protocol verbatim to its webview and leaves `.input`
/// native-only.
@available(macOS 26.0, *)
final class AgentLaneServer: AgentDataPushing, @unchecked Sendable {
    private static let agentTerminalRequestTypes: Set<String> = [
        "agent-terminal-open",
        "agent-terminal-attached",
        "agent-terminal-close",
    ]

    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private var receiveTask: Task<Void, Never>?
    // Every host -> agent frame on this QUIC stream shares one byte lane, exactly like the input
    // lane's send chain (ADR-0030, ADR-0058): synchronous enqueue under the lock preserves
    // producer call order and each async write waits for its predecessor so frames never interleave.
    private let sendChain = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

    var agentRequestHandler: ((AgentFeedRequest) -> Void)?
    var onClosed: (() -> Void)?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
        startReceiveLoop()
    }

    func close() {
        receiveTask?.cancel()
        receiveTask = nil
        sendChain.withLock { tail in
            tail?.cancel()
            tail = nil
        }
        agentRequestHandler = nil
        onClosed = nil
    }

    func pushAgentData(_ data: Data) {
        enqueuePayload(data)
    }

    func pushAgentSay(_ push: AgentSayPush) {
        do {
            pushAgentData(try JSONEncoder().encode(push))
        } catch {
            logger.error("agent lane agent-say encode failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func enqueuePayload(_ payload: Data) {
        sendChain.withLock { tail in
            let prior = tail
            tail = Task { [stream, logger, payload] in
                _ = await prior?.value
                guard !Task.isCancelled else { return }
                do {
                    try await QuicSessionStreamIO.sendPayload(payload, role: .agent, on: stream)
                    logger.notice("agent lane SENT \(payload.count) bytes")
                } catch {
                    logger.error("agent lane send failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    private func startReceiveLoop() {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .agent)
                    guard frame.role == .agent else { continue }
                    dispatch(data: frame.payload)
                } catch {
                    logger.notice("agent lane receive ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
                    // A receive ending while we iterated means the peer dropped the lane. Only a
                    // peer-initiated drop is a disconnect; a cancelled receive loop is our own
                    // `close()` (session teardown or a newer lane superseding this one), so it must
                    // not re-enter the owner's teardown path.
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
            logger.error("agent lane frame missing type discriminator")
            return
        }
        logger.notice("agent lane RECV type=\(header.type, privacy: .public) fp=\(self.fingerprint.rawValue, privacy: .public)")
        if Self.agentTerminalRequestTypes.contains(header.type) {
            if !InputChannelServer.dispatchAgentTerminal(
                data: data,
                handler: agentRequestHandler
            ) {
                logger.error("agent terminal request decode failed")
            }
            return
        }
        switch header.type {
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
            if let msg = try? JSONDecoder().decode(AgentThreadSubscribe.self, from: data) {
                agentRequestHandler?(.threadSubscribe(msg))
            }
        case "agent-thread-older":
            if let msg = try? JSONDecoder().decode(AgentThreadLoadOlder.self, from: data) {
                agentRequestHandler?(.threadLoadOlder(msg))
            }
        case "agent-thread-unsub":
            if let msg = try? JSONDecoder().decode(AgentThreadUnsubscribe.self, from: data) {
                agentRequestHandler?(.threadUnsubscribe(msg))
            }
        case "agent-raw-event-get":
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
        default:
            logger.notice("agent lane unknown frame type=\(header.type, privacy: .public)")
        }
    }

    private struct InboundFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}