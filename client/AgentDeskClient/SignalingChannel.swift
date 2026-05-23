import Foundation

// ADR-0004 signaling seam. Mirror of host/AgentDeskHost/SignalingChannel.swift.

protocol SignalingChannel: AnyObject {
    func send(_ frame: WebRTCSignalingFrame) async throws
    var inbound: AsyncStream<WebRTCSignalingFrame> { get }
}
