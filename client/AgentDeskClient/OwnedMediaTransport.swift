import CryptoKit
import Foundation
import Network
import OSLog
import Security
import AgentDeskWire

@available(iOS 26.0, *)
final class QuicSessionClientTransport: InputChannel, MediaTransport, SessionTransport, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "session-quic")
    private let connection: NetworkConnection<QUIC>
    private let inputStream: QUIC.Stream<QUICStream>
    // ADR-0034 crisp-repair: the reliable lane the host pushes crisp tiles on.
    private let graphicsStream: QUIC.Stream<QUICStream>
    private let datagrams: QUIC.Datagrams<QUICDatagram>
    private let mediaRepairBuffer = MediaDatagramFrameRepairBuffer(
        repairDeadlineNs: UInt64(Config.ownedMediaRepairDeadlineMs) * 1_000_000,
        trackedFrameLimit: Config.ownedMediaTrackedFrameLimit,
        maxResendPackets: Config.ownedMediaMaxResendPackets
    )
    private let desktopStateContinuation: AsyncStream<DesktopState>.Continuation
    let desktopStateUpdates: AsyncStream<DesktopState>
    private let thumbnailsContinuation: AsyncStream<[String: String]>.Continuation
    let thumbnailsUpdates: AsyncStream<[String: String]>
    private let topWindowsContinuation: AsyncStream<[String: SpaceTopWindow]>.Continuation
    let topWindowsUpdates: AsyncStream<[String: SpaceTopWindow]>
    private let agentSayContinuation: AsyncStream<AgentSayPush>.Continuation
    let agentSayUpdates: AsyncStream<AgentSayPush>
    private let cursorContinuation: AsyncStream<CursorImagePush>.Continuation
    let cursorUpdates: AsyncStream<CursorImagePush>
    private let cursorPositionContinuation: AsyncStream<CursorPositionPush>.Continuation
    let cursorPositionUpdates: AsyncStream<CursorPositionPush>
    private let diagnosticsContinuation: AsyncStream<InputChannelDiagnosticsUpdate>.Continuation
    let diagnosticsUpdates: AsyncStream<InputChannelDiagnosticsUpdate>
    private let closedContinuation: AsyncStream<Void>.Continuation
    let closed: AsyncStream<Void>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    private let lock = OSAllocatedUnfairLock<State>(initialState: State())
    private var datagramReceiveTask: Task<Void, Never>?
    private var inputReceiveTask: Task<Void, Never>?
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
        mediaKey: SymmetricKey
    ) {
        self.connection = connection
        self.inputStream = inputStream
        self.graphicsStream = graphicsStream
        self.datagrams = datagrams
        self.activeSession = activeSession
        self.mediaKey = mediaKey

        var dsCont: AsyncStream<DesktopState>.Continuation!
        desktopStateUpdates = AsyncStream { dsCont = $0 }
        desktopStateContinuation = dsCont
        var thCont: AsyncStream<[String: String]>.Continuation!
        thumbnailsUpdates = AsyncStream { thCont = $0 }
        thumbnailsContinuation = thCont
        var twCont: AsyncStream<[String: SpaceTopWindow]>.Continuation!
        topWindowsUpdates = AsyncStream { twCont = $0 }
        topWindowsContinuation = twCont
        var sayCont: AsyncStream<AgentSayPush>.Continuation!
        agentSayUpdates = AsyncStream { sayCont = $0 }
        agentSayContinuation = sayCont
        var cursorCont: AsyncStream<CursorImagePush>.Continuation!
        cursorUpdates = AsyncStream { cursorCont = $0 }
        cursorContinuation = cursorCont
        var cursorPositionCont: AsyncStream<CursorPositionPush>.Continuation!
        cursorPositionUpdates = AsyncStream { cursorPositionCont = $0 }
        cursorPositionContinuation = cursorPositionCont
        var diagnosticsCont: AsyncStream<InputChannelDiagnosticsUpdate>.Continuation!
        diagnosticsUpdates = AsyncStream { diagnosticsCont = $0 }
        diagnosticsContinuation = diagnosticsCont
        var closedCont: AsyncStream<Void>.Continuation!
        closed = AsyncStream { closedCont = $0 }
        closedContinuation = closedCont
        var stateCont: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { stateCont = $0 }
        stateContinuation = stateCont

        connection.onStateUpdate { [weak self] _, state in
            self?.handleConnectionState(state)
        }
        startInputReceiveLoop()
        startDatagramReceiveLoop()
        // The graphics lane starts in start(), once the sink exists: it announces the lane
        // (prompting the host to push) only after there is a sink to consume the frames, so
        // the host's resetSurface + first tiles are never dropped before the sink is set.
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        stateContinuation.yield(.connected)
        if let mediaSink = videoSink as? any OwnedMediaFrameSink {
            let datagrams = self.datagrams
            // Set the sink on the MainActor, where every reader (the graphics and datagram
            // loops) also touches it, so the write and reads stay on one actor.
            await MainActor.run { [weak self, datagrams, weak mediaSink] in
                self?.sink = mediaSink
                mediaSink?.setVideoKeyframeRequestHandler {
                    Task { [datagrams] in
                        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: 0)
                        guard let data = try? JSONEncoder().encode(message) else { return }
                        try? await datagrams.send(data)
                    }
                }
            }
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

    func send(_ input: NormalizedInput) async throws {
        try await QuicSessionStreamIO.send(
            InputChannelEvent(event: input),
            role: .input,
            on: inputStream
        )
    }

    func sendConfig(_ config: ClientConfig) async throws {
        try await QuicSessionStreamIO.send(config, role: .input, on: inputStream)
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

    // MARK: - Agent-feed subscription sends (mirrors sendDiagnostics* pattern)

    func sendAgentProjectsSubscribe() async throws {
        try await QuicSessionStreamIO.send(AgentProjectsSubscribe(), role: .input, on: inputStream)
    }

    func sendAgentThreadSubscribe(_ request: AgentThreadSubscribe) async throws {
        try await QuicSessionStreamIO.send(request, role: .input, on: inputStream)
    }

    func sendAgentThreadLoadOlder(_ request: AgentThreadLoadOlder) async throws {
        try await QuicSessionStreamIO.send(request, role: .input, on: inputStream)
    }

    func sendAgentThreadUnsubscribe(_ request: AgentThreadUnsubscribe) async throws {
        try await QuicSessionStreamIO.send(request, role: .input, on: inputStream)
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
        desktopStateContinuation.finish()
        thumbnailsContinuation.finish()
        topWindowsContinuation.finish()
        agentSayContinuation.finish()
        cursorContinuation.finish()
        cursorPositionContinuation.finish()
        diagnosticsContinuation.finish()
        closedContinuation.yield(())
        closedContinuation.finish()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
        connection.applicationError = .init(code: 0, reason: "client-close")
    }

    private func startInputReceiveLoop() {
        inputReceiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: inputStream)
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

    private func startDatagramReceiveLoop() {
        datagramReceiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let message = try await datagrams.receive()
                    handleVideoDatagram(message.content)
                } catch {
                    logger.notice("video datagram receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    private func handleInputPayload(_ data: Data) {
        guard let header = try? JSONDecoder().decode(InputFrameHeader.self, from: data) else {
            return
        }
        switch header.type {
        case "desktop-state":
            if let push = try? JSONDecoder().decode(DesktopStatePush.self, from: data) {
                desktopStateContinuation.yield(push.state)
            }
        case "thumbnails-push":
            if let push = try? JSONDecoder().decode(ThumbnailsPush.self, from: data) {
                thumbnailsContinuation.yield(push.thumbnails)
                topWindowsContinuation.yield(push.topWindows ?? [:])
            }
        case "agent-say":
            if let push = try? JSONDecoder().decode(AgentSayPush.self, from: data) {
                agentSayContinuation.yield(push)
            }
        case "cursor":
            if let push = try? JSONDecoder().decode(CursorImagePush.self, from: data) {
                cursorContinuation.yield(push)
            }
        case "cursor-position":
            if let push = try? JSONDecoder().decode(CursorPositionPush.self, from: data) {
                cursorPositionContinuation.yield(push)
            }
        case "diagnostics-request":
            if let request = try? JSONDecoder().decode(DiagnosticsRequest.self, from: data) {
                diagnosticsContinuation.yield(.request(request))
            }
        case "agent-projects":
            logger.debug("input lane agent-projects received")
            if let json = String(data: data, encoding: .utf8) {
                let closure = onAgentPush
                Task { @MainActor in closure?(json) }
            }
        case "agent-thread-chunk":
            logger.debug("input lane agent-thread-chunk received")
            if let json = String(data: data, encoding: .utf8) {
                let closure = onAgentPush
                Task { @MainActor in closure?(json) }
            }
        case "agent-thread-error":
            logger.debug("input lane agent-thread-error received")
            if let json = String(data: data, encoding: .utf8) {
                let closure = onAgentPush
                Task { @MainActor in closure?(json) }
            }
        case "session-rejected":
            close()
        default:
            logger.debug("input lane ignored frame type=\(header.type, privacy: .public)")
        }
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
        let result = lock.withLock { state in
            let accepted = mediaRepairBuffer.accept(packet, now: DispatchTime.now().uptimeNanoseconds)
            state.completedFrames += accepted.completedFrames.count
            state.expiredFrames += accepted.expiredFrames.count
            return accepted
        }
        for completed in result.completedFrames {
            guard let envelope = try? OwnedMediaFrameEnvelope.decode(completed.data) else { continue }
            sendVideoControl(OwnedMediaControlMessage(kind: .frameAck, frameId: completed.frameId))
            Task { @MainActor [weak self] in
                self?.sink?.renderOwnedVideoFrame(envelope, frameBytes: completed.data.count)
            }
        }
        for request in result.resendRequests {
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
        if let expired = result.expiredFrames.last {
            let expiredCount = result.expiredFrames.count
            Task { @MainActor [weak self] in
                self?.sink?.noteOwnedMediaDroppedFrames(expiredCount)
                self?.sink?.noteOwnedMediaRepairExpired(expiredCount)
            }
            ClientDiagnostics.shared.record(
                type: "mediaRepairDeadlineMissed",
                fields: [
                    "frameId": String(expired.frameId),
                    "expiredFrameCount": String(expiredCount)
                ],
                level: .error
            )
            sendVideoControl(OwnedMediaControlMessage(kind: .keyframeRequest, frameId: expired.frameId))
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
        let counts = lock.withLock { state -> (Int, Int) in
            let counts = (state.completedFrames, state.expiredFrames)
            state.completedFrames = 0
            state.expiredFrames = 0
            return counts
        }
        guard counts.0 > 0 || counts.1 > 0 else { return }
        ClientDiagnostics.shared.record(
            type: "mediaLinkHealthSummary",
            fields: [
                "completedFrames": String(counts.0),
                "expiredFrames": String(counts.1)
            ],
            level: .info
        )
        sendVideoControl(OwnedMediaControlMessage(
            kind: .linkHealth,
            frameId: 0,
            linkHealthCompletedFrames: counts.0,
            linkHealthExpiredFrames: counts.1
        ))
    }

    private func sendVideoControl(_ message: OwnedMediaControlMessage) {
        Task { [datagrams] in
            guard let data = try? JSONEncoder().encode(message) else { return }
            try? await datagrams.send(data)
        }
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
            stateContinuation.yield(.failed(nil))
            close()
        case .cancelled:
            close()
        default:
            break
        }
    }

    private struct State {
        var closed = false
        var completedFrames = 0
        var expiredFrames = 0
    }

    private struct InputFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}
