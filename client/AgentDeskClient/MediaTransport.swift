import Foundation
import UIKit

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws
    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed(SessionRejected?)
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaTransportError: Error {
    case notYetImplemented
}

protocol VideoFrameSource: AnyObject, Sendable {
    func start() async throws
    func stop()
}

protocol VideoFrameSink: AnyObject, Sendable {
    @MainActor var view: UIView { get }
}
