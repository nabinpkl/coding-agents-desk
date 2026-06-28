import Foundation

enum InputChannelDiagnosticsUpdate: Equatable, Sendable {
    case request(DiagnosticsRequest)
}

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
    var diagnosticsUpdates: AsyncStream<InputChannelDiagnosticsUpdate> { get }

    func sendConfig(_ config: ClientConfig) async throws
    func sendDiagnosticsSummary(_ summary: DiagnosticsSummary) async throws
    func sendDiagnosticsChunk(_ chunk: DiagnosticsChunk) async throws
    func sendDiagnosticsError(_ error: DiagnosticsError) async throws

    var closed: AsyncStream<Void> { get }
}

enum InputChannelError: Error {
    case notOpen
    case encodeFailed
    case malformedURL
}
