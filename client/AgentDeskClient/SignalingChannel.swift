protocol SignalingChannel: AnyObject, Sendable {
    func close()
}

protocol InputCapabilityRefreshing: AnyObject, Sendable {
    func refreshInputCapability(deviceFingerprint: DeviceFingerprint, sessionId: String) async throws -> InputCapabilityGrant
}

protocol MediaCapabilityRefreshing: AnyObject, Sendable {
    func refreshMediaCapability(deviceFingerprint: DeviceFingerprint, sessionId: String) async throws -> MediaCapabilityGrant
}
