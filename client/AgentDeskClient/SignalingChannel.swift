protocol SignalingChannel: AnyObject, Sendable {
    func close()
}

protocol InputCapabilityRefreshing: AnyObject, Sendable {
    func refreshInputCapability(deviceFingerprint: DeviceFingerprint, sessionId: String) async throws -> InputCapabilityGrant
}
