import Foundation

// ADR-0004 signaling seam. Wraps the post-SessionReady frames on the
// authenticated WebSocket. The concrete impl
// (WebSocketSignalingChannel) lands in R8.6.2; tests can substitute an
// in-memory channel without touching transport code.

protocol SignalingChannel: AnyObject, Sendable {
    func send(_ frame: WebRTCSignalingFrame) async throws
    var inbound: AsyncStream<WebRTCSignalingFrame> { get }
}
