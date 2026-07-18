import Foundation
import AgentDeskWire

enum InputChannelDiagnosticsUpdate: Equatable, Sendable {
    case request(DiagnosticsRequest)
}

enum CursorReconciliationUpdate: Equatable, Sendable {
    case applied(CursorAppliedPush)
    case hostMoved(HostCursorMovedPush)
}

// ADR-0030: input is a reliable lane on the authenticated QUIC session,
// not a separate WebSocket. The concrete implementation is
// QuicSessionClientTransport.
protocol InputChannel: AnyObject, Sendable {
    func send(_ event: InputChannelEvent) async throws
    func close()

    var desktopStateUpdates: AsyncStream<DesktopState> { get }
    var thumbnailsUpdates: AsyncStream<[String: String]> { get }
    var topWindowsUpdates: AsyncStream<[String: SpaceTopWindow]> { get }
    var agentSayUpdates: AsyncStream<AgentSayPush> { get }
    var cursorUpdates: AsyncStream<CursorImagePush> { get }
    var cursorReconciliationUpdates: AsyncStream<CursorReconciliationUpdate> { get }
    var hostAvailabilityUpdates: AsyncStream<HostAvailabilityPush> { get }
    var textInputFocusUpdates: AsyncStream<HostTextInputFocusPush> { get }
    var diagnosticsUpdates: AsyncStream<InputChannelDiagnosticsUpdate> { get }
    var agentTerminalUpdates: AsyncStream<AgentTerminalHostMessage> { get }

    func sendConfig(_ config: ClientConfig) async throws
    // Best-effort revoke notice sent just before teardown when the user unpairs,
    // so the host drops its paired-device record instead of holding a zombie.
    func sendRevoke() async throws
    func sendDiagnosticsSummary(_ summary: DiagnosticsSummary) async throws
    func sendDiagnosticsChunk(_ chunk: DiagnosticsChunk) async throws
    func sendDiagnosticsError(_ error: DiagnosticsError) async throws

    // Agent requests encode shared t-tagged types on the authenticated input lane.
    func sendAgentProjectsSubscribe() async throws
    func sendAgentThreadSubscribe(_ request: AgentThreadSubscribe) async throws
    func sendAgentThreadLoadOlder(_ request: AgentThreadLoadOlder) async throws
    func sendAgentThreadUnsubscribe(_ request: AgentThreadUnsubscribe) async throws
    func sendAgentRawEventRequest(_ request: AgentRawEventRequest) async throws
    func sendAgentTerminal(_ message: AgentTerminalClientMessage) async throws

    var closed: AsyncStream<Void> { get }
}

enum InputChannelError: Error {
    case notOpen
    case encodeFailed
    case malformedURL
}
