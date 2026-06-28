import Foundation
import Network
import os

protocol InputChannelServing: AnyObject, Sendable {
    var events: AsyncStream<NormalizedInput> { get }
    var configHandler: ((ClientConfig) -> Void)? { get set }

    func close()
    func pushDesktopState(_ state: DesktopState)
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow])
    func pushAgentSay(_ push: AgentSayPush)
    func pushCursor(_ push: CursorImagePush)
}

@available(macOS 26.0, *)
final class InputChannelServer: InputChannelServing, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "input-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private var continuation: AsyncStream<NormalizedInput>.Continuation?
    private var receiveTask: Task<Void, Never>?

    let events: AsyncStream<NormalizedInput>
    var configHandler: ((ClientConfig) -> Void)?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
        var captured: AsyncStream<NormalizedInput>.Continuation?
        events = AsyncStream { continuation in
            captured = continuation
        }
        continuation = captured
        startReceiveLoop()
    }

    func close() {
        receiveTask?.cancel()
        receiveTask = nil
        continuation?.finish()
        continuation = nil
        configHandler = nil
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

    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow] = [:]) {
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
                    close()
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
        case "client-config":
            do {
                let frame = try JSONDecoder().decode(ClientConfig.self, from: data)
                configHandler?(frame)
            } catch {
                logger.error("client-config decode failed: \(String(describing: error), privacy: .public)")
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
