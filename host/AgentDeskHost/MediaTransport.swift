import Foundation

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws
    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

struct OwnedMediaDiagnosticsFpsWindow: Equatable {
    private(set) var windowStartedAtUptimeNs: UInt64
    private(set) var captured = 0
    private(set) var admitted = 0
    private(set) var encoded = 0
    private(set) var sent = 0
    private(set) var acked = 0

    init(windowStartedAtUptimeNs: UInt64) {
        self.windowStartedAtUptimeNs = windowStartedAtUptimeNs
    }

    mutating func incrementCaptured() { captured += 1 }
    mutating func incrementAdmitted() { admitted += 1 }
    mutating func incrementEncoded() { encoded += 1 }
    mutating func incrementSent() { sent += 1 }
    mutating func incrementAcked() { acked += 1 }

    mutating func flushIfDue(nowUptimeNs: UInt64) -> OwnedMediaDiagnosticsFpsSample? {
        guard nowUptimeNs >= windowStartedAtUptimeNs,
              nowUptimeNs - windowStartedAtUptimeNs >= 1_000_000_000
        else {
            return nil
        }
        let elapsedSeconds = max(Double(nowUptimeNs - windowStartedAtUptimeNs) / 1_000_000_000.0, 0.001)
        let sample = OwnedMediaDiagnosticsFpsSample(
            elapsedSeconds: elapsedSeconds,
            captured: captured,
            admitted: admitted,
            encoded: encoded,
            sent: sent,
            acked: acked
        )
        windowStartedAtUptimeNs = nowUptimeNs
        captured = 0
        admitted = 0
        encoded = 0
        sent = 0
        acked = 0
        return sample
    }
}

struct OwnedMediaDiagnosticsFpsSample: Equatable {
    let elapsedSeconds: Double
    let captured: Int
    let admitted: Int
    let encoded: Int
    let sent: Int
    let acked: Int

    func fps(_ count: Int) -> Double {
        Double(count) / elapsedSeconds
    }
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaTransportError: Error {
    case notYetImplemented
}

struct OwnedQuicListenerConfiguration: Equatable, Sendable {
    let alpn: String
    let port: UInt16
    let usesDatagrams: Bool
    let maxDatagramFrameSize: Int?
}

enum OwnedQuicListenerConfigurations {
    static let graphicsALPN = "agentdesk-owned-graphics"

    static func graphics() -> OwnedQuicListenerConfiguration {
        // ADR-0025: when the motion carrier is on, advertise QUIC DATAGRAM frames so
        // the video stream can ride the same group as the reliable tile streams.
        // isDatagram stays false, so the streams are unaffected. When the flag is off
        // the parameters are identical to before, so the daily-driver path is untouched.
        OwnedQuicListenerConfiguration(
            alpn: graphicsALPN,
            port: Config.graphicsPort,
            usesDatagrams: false,
            maxDatagramFrameSize: Config.ownedMediaVideoMotionEnabled ? Config.ownedMediaMaxDatagramFrameSize : nil
        )
    }
}

enum OwnedGraphicsHandshake {
    static func validateHelloData(_ data: Data) throws -> GraphicsChannelHello {
        guard !data.isEmpty,
              let hello = try? JSONDecoder().decode(GraphicsChannelHello.self, from: data),
              hello.type == "graphics-hello",
              !hello.clientNonce.isEmpty
        else {
            throw SessionRejected(reason: .malformed)
        }
        return hello
    }
}

protocol VideoFrameSink: AnyObject, Sendable {}
