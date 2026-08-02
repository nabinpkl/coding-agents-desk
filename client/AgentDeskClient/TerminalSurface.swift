import Foundation
import AgentDeskWire
import PtyClientSwift
import PtyTerminalWebView
import UIKit

@available(iOS 26.0, *)
@MainActor
final class TerminalSurface: UIView, KeyboardSurfaceDelegate, PtyTerminalWebViewDelegate {
    let terminalContent = PtyTerminalWebView(
        profile: .workspace,
        inputMode: .nativeProxy
    )
    let terminalKeyboardSurface = KeyboardSurface(
        echoesLocally: false,
        showsDismissKey: true
    )
    private var backend: RemoteTerminalWorkspaceBackend?
    private var isViewportPresented = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = PtyTerminalSurfaceAppearance.surface
        accessibilityIdentifier = "terminal-surface"
        terminalContent.translatesAutoresizingMaskIntoConstraints = false
        terminalContent.delegate = self
        addSubview(terminalContent)
        terminalKeyboardSurface.translatesAutoresizingMaskIntoConstraints = false
        terminalKeyboardSurface.keyboardDelegate = self
        terminalKeyboardSurface.alpha = 0.01
        terminalKeyboardSurface.isAccessibilityElement = false
        terminalKeyboardSurface.accessibilityIdentifier = "terminal-keyboard-proxy"
        addSubview(terminalKeyboardSurface)
        NSLayoutConstraint.activate([
            terminalContent.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalContent.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalContent.topAnchor.constraint(equalTo: topAnchor),
            terminalContent.bottomAnchor.constraint(equalTo: bottomAnchor),
            terminalKeyboardSurface.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalKeyboardSurface.bottomAnchor.constraint(equalTo: bottomAnchor),
            terminalKeyboardSurface.widthAnchor.constraint(equalToConstant: 1),
            terminalKeyboardSurface.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func connect(using transport: QuicSessionClientTransport?) {
        guard let transport else {
            detach()
            return
        }
        if backend?.transport !== transport {
            terminalContent.detach()
            let backend = RemoteTerminalWorkspaceBackend(transport: transport)
            self.backend = backend
            terminalContent.configureWorkspaceBackend(backend)
            terminalContent.setViewportActive(isViewportPresented, claim: false)
        }
    }

    func detach() {
        terminalKeyboardSurface.setVisible(false)
        terminalContent.setViewportActive(false)
        terminalContent.detach()
        backend = nil
    }

    func setViewportPresented(_ presented: Bool) {
        guard isViewportPresented != presented else { return }
        isViewportPresented = presented
        if !presented {
            terminalKeyboardSurface.setVisible(false)
        }
        terminalContent.setViewportActive(presented, claim: presented)
    }

    func flushViewportResize() { terminalContent.flushViewportResize() }

    func ptyTerminalContentDidRequestInputFocus(_ content: PtyTerminalWebView) {
        guard content === terminalContent, isViewportPresented else { return }
        terminalKeyboardSurface.setVisible(true)
    }

    func keyboardSurface(_ surface: KeyboardSurface, didProduce input: NormalizedInput) {
        guard surface === terminalKeyboardSurface,
              case .key(let code, let modifiers) = input else { return }
        terminalContent.sendKey(
            code: code,
            modifiers: modifiers.map { modifier in
                switch modifier {
                case .cmd: .command
                case .ctrl: .control
                case .option: .option
                case .shift: .shift
                }
            }
        )
    }
}

@available(iOS 26.0, *)
@MainActor
private final class RemoteTerminalWorkspaceBackend: PtyTerminalWorkspaceBackend {
    weak var transport: QuicSessionClientTransport?
    private var nextSessionOrdinal: UInt64 = 1

    init(transport: QuicSessionClientTransport) { self.transport = transport }

    func makeFreshSessionName() -> String {
        defer { nextSessionOrdinal += 1 }
        return "agentdesk-\(nextSessionOrdinal)-\(UUID().uuidString.lowercased().prefix(8))"
    }

    func openSession(_ request: PtyTerminalOpenRequest) async throws -> PtySessionConnection {
        guard let transport else { throw PtyClientError.closed }
        let client = try await transport.openTerminalPtyClient()
        return try await client.openSession(
            name: request.sessionName,
            launch: .shell(cwd: "", shell: ""),
            columns: request.dimensions.columns,
            rows: request.dimensions.rows,
            createIfMissing: request.createIfMissing,
            clientTitle: "AgentDesk iPhone"
        )
    }

    func sessionSnapshots() async throws -> AsyncThrowingStream<[PtySessionSummary], Error> {
        guard let transport else { throw PtyClientError.closed }
        return try await transport.openTerminalPtyClient().sessionSnapshots()
    }

    func listSessions() async throws -> [PtySessionSummary] {
        guard let transport else { throw PtyClientError.closed }
        return try await transport.openTerminalPtyClient().listSessions()
    }

    func killSession(named name: String) async throws {
        guard let transport else { throw PtyClientError.closed }
        try await transport.openTerminalPtyClient().killSession(name: name)
    }

    func closeClient(sessionName: String, clientID: UInt64) async throws {
        guard let transport else { throw PtyClientError.closed }
        try await transport.openTerminalPtyClient().closeClient(sessionName: sessionName, clientID: clientID)
    }
}
