import Foundation

// ADR-0030: input is a reliable lane on the authenticated QUIC session,
// not a separate WebSocket. The concrete implementation is
// QuicSessionClientTransport.
protocol InputChannel: AnyObject, Sendable {
    func send(_ input: NormalizedInput) async throws
    func close()

    var desktopStateUpdates: AsyncStream<DesktopState> { get }
    var thumbnailsUpdates: AsyncStream<[String: String]> { get }
    var topWindowsUpdates: AsyncStream<[String: SpaceTopWindow]> { get }
    var agentSayUpdates: AsyncStream<AgentSayPush> { get }
    var cursorUpdates: AsyncStream<CursorImagePush> { get }

    func sendConfig(_ config: ClientConfig) async throws

    var closed: AsyncStream<Void> { get }
}

enum InputChannelError: Error {
    case notOpen
    case encodeFailed
    case malformedURL
}
