import Foundation

// ADR-0004 signaling seam. Mirror of host/AgentDeskHost/SignalingChannel.swift.

protocol SignalingChannel: AnyObject, Sendable {
    func send(_ frame: WebRTCSignalingFrame) async throws
    func close()
    var inbound: AsyncStream<WebRTCSignalingFrame> { get }
}

protocol InputCapabilityRefreshing: AnyObject, Sendable {
    func refreshInputCapability(deviceFingerprint: DeviceFingerprint, sessionId: String) async throws -> InputCapabilityGrant
}
