import CryptoKit
import Foundation
import Network
import OSLog
import Security

@available(iOS 26.0, *)
final class QuicSessionClientTransport: InputChannel, MediaTransport, SessionTransport, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "session-quic")
    private let connection: NetworkConnection<QUIC>
    private let inputStream: QUIC.Stream<QUICStream>
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
    private let closedContinuation: AsyncStream<Void>.Continuation
    let closed: AsyncStream<Void>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    private let lock = OSAllocatedUnfairLock<State>(initialState: State())
    private var datagramReceiveTask: Task<Void, Never>?
    private var inputReceiveTask: Task<Void, Never>?
    private var linkHealthTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?

    let activeSession: ActiveSession
    let mediaKey: SymmetricKey

    init(
        connection: NetworkConnection<QUIC>,
        inputStream: QUIC.Stream<QUICStream>,
        datagrams: QUIC.Datagrams<QUICDatagram>,
        activeSession: ActiveSession,
        mediaKey: SymmetricKey
    ) {
        self.connection = connection
        self.inputStream = inputStream
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
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        stateContinuation.yield(.connected)
        if let mediaSink = videoSink as? any OwnedMediaFrameSink {
            sink = mediaSink
            let datagrams = self.datagrams
            await MainActor.run { [datagrams, weak mediaSink] in
                mediaSink?.setVideoKeyframeRequestHandler {
                    Task { [datagrams] in
                        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: 0)
                        guard let data = try? JSONEncoder().encode(message) else { return }
                        try? await datagrams.send(data)
                    }
                }
            }
            startLinkHealthReporting()
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

    func close() {
        guard lock.withLock({ state in
            if state.closed { return false }
            state.closed = true
            return true
        }) else { return }
        datagramReceiveTask?.cancel()
        inputReceiveTask?.cancel()
        linkHealthTask?.cancel()
        desktopStateContinuation.finish()
        thumbnailsContinuation.finish()
        topWindowsContinuation.finish()
        agentSayContinuation.finish()
        cursorContinuation.finish()
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
            Task { @MainActor [weak self] in
                self?.sink?.renderOwnedVideoFrame(envelope)
            }
        }
        for request in result.resendRequests {
            sendVideoControl(OwnedMediaControlMessage(
                kind: .packetResendRequest,
                frameId: request.frameId,
                packetIndexes: request.packetIndexes
            ))
        }
        if let expired = result.expiredFrames.last {
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
