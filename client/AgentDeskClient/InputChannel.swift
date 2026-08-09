import Foundation
import AgentDeskWire

enum InputChannelDiagnosticsUpdate: Equatable, Sendable {
    case request(DiagnosticsRequest)
}

enum InputChannelScreenshotUpdate: Equatable, Sendable {
    case request(ClientScreenshotRequest)
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
    var windowListUpdates: AsyncStream<WindowListPush> { get }
    var agentSayUpdates: AsyncStream<AgentSayPush> { get }
    var cursorUpdates: AsyncStream<CursorImagePush> { get }
    var cursorReconciliationUpdates: AsyncStream<CursorReconciliationUpdate> { get }
    var hostAvailabilityUpdates: AsyncStream<HostAvailabilityPush> { get }
    var textInputFocusUpdates: AsyncStream<HostTextInputFocusPush> { get }
    var diagnosticsUpdates: AsyncStream<InputChannelDiagnosticsUpdate> { get }
    var screenshotUpdates: AsyncStream<InputChannelScreenshotUpdate> { get }
    var agentTerminalUpdates: AsyncStream<AgentTerminalHostMessage> { get }
    var workspaceTerminalUpdates: AsyncStream<WorkspaceTerminalHostMessage> { get }

    func sendConfig(_ config: ClientConfig) async throws
    // Sent on every surface change: the host stops encoding for this client
    // while a full-screen surface covers the video.
    func sendMediaViewerState(_ state: MediaViewerState) async throws
    // Best-effort revoke notice sent just before teardown when the user unpairs,
    // so the host drops its paired-device record instead of holding a zombie.
    func sendRevoke() async throws
    func sendDiagnosticsSummary(_ summary: DiagnosticsSummary) async throws
    func sendDiagnosticsChunk(_ chunk: DiagnosticsChunk) async throws
    func sendDiagnosticsError(_ error: DiagnosticsError) async throws
    func sendRuntimeCheckpoint(_ checkpoint: ClientRuntimeCheckpoint) async throws
    func sendScreenshotManifest(_ manifest: ClientScreenshotManifest) async throws
    func sendScreenshotChunk(_ chunk: ClientScreenshotChunk) async throws
    func sendScreenshotError(_ error: ClientScreenshotError) async throws

    // Agent requests encode shared t-tagged types on the authenticated input lane.
    func sendAgentProjectsWatch(_ request: AgentProjectsWatch) async throws
    func sendAgentProjectsUnwatch(_ request: AgentProjectsUnwatch) async throws
    func sendAgentProjectSessionsWatch(_ request: AgentProjectSessionsWatch) async throws
    func sendAgentProjectSessionsUnwatch(_ request: AgentProjectSessionsUnwatch) async throws
    func sendAgentThreadSubscribe(_ request: AgentThreadSubscribe) async throws
    func sendAgentThreadLoadOlder(_ request: AgentThreadLoadOlder) async throws
    func sendAgentThreadUnsubscribe(_ request: AgentThreadUnsubscribe) async throws
    func sendAgentRawEventRequest(_ request: AgentRawEventRequest) async throws
    func sendAgentSessionCreate(_ request: AgentSessionCreate) async throws
    func sendAgentSessionSend(_ request: AgentSessionSend) async throws
    func sendAgentSessionAbort(_ request: AgentSessionAbort) async throws
    func sendAgentExtensionUIResponse(_ response: AgentExtensionUIResponse) async throws
    func sendAgentTerminal(_ message: AgentTerminalClientMessage) async throws
    func sendWorkspaceTerminal(_ message: WorkspaceTerminalClientMessage) async throws
    // Claude Desktop composer sync. Carried on this lane like the agent requests above, but answered by
    // the host's own Accessibility path rather than the transcript sidecar.
    func sendAgentWindowInputWatch(_ request: AgentWindowInputWatch) async throws
    func sendAgentWindowInputUnwatch(_ request: AgentWindowInputUnwatch) async throws
    func sendAgentWindowInputSync(_ request: AgentWindowInputSync) async throws
    func sendAgentWindowInputRead(_ request: AgentWindowInputRead) async throws
    func sendAgentWindowInputSubmit(_ request: AgentWindowInputSubmit) async throws
    // AskUserQuestion panel state, answered on the same Accessibility-answered lane.
    func sendAgentWindowQuestionWatch(_ request: AgentWindowQuestionWatch) async throws
    func sendAgentWindowQuestionUnwatch(_ request: AgentWindowQuestionUnwatch) async throws
    func sendAgentWindowQuestionAction(_ request: AgentWindowQuestionAction) async throws

    var closed: AsyncStream<Void> { get }
}

enum InputChannelError: Error {
    case notOpen
    case encodeFailed
    case malformedURL
}
