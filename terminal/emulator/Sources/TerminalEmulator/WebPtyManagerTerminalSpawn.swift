import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalWebView

public enum WebPtyManagerTerminalSpawnError: Error, Equatable {
    case managerUnavailable(String)
}

@MainActor
final class LocalTerminalWorkspaceBackend: PtyTerminalWorkspaceBackend {
    private let client: PtyClient
    private let cwd: String
    private let shell: String

    init(client: PtyClient, cwd: String, shell: String) {
        self.client = client
        self.cwd = cwd
        self.shell = shell
    }

    func makeFreshSessionName() -> String { "agentdesk-\(UUID().uuidString.lowercased())" }

    func openSession(_ request: PtyTerminalOpenRequest) async throws -> PtySessionConnection {
        try await client.openSession(
            name: request.sessionName,
            launch: .shell(cwd: cwd, shell: shell),
            lifetime: .persistent,
            columns: request.dimensions.columns,
            rows: request.dimensions.rows,
            createIfMissing: request.createIfMissing,
            clientTitle: "AgentDesk Mac"
        )
    }

    func listSessions() async throws -> [PtySessionSummary] { try await client.listSessions() }

    func sessionSnapshots() async throws -> AsyncThrowingStream<[PtySessionSummary], Error> {
        client.sessionSnapshots()
    }

    func killSession(named name: String) async throws { try await client.killSession(name: name) }

    func closeClient(sessionName: String, clientID: UInt64) async throws {
        try await client.closeClient(sessionName: sessionName, clientID: clientID)
    }
}

@MainActor
public final class WebPtyManagerTerminalSpawn: TerminalEmulatorSpawn {
    private let client: PtyClient
    private let shell: String

    // `client` is required (no default): a defaulted `PtyClient()` would silently dial the donor's
    // `/tmp/pty-manager.sock`, defeating AgentDesk's bundle-scoped socket. Callers inject a client
    // bound to their own socket (the host passes `PtyManagerSocketClient.makeClient()`).
    public init(
        client: PtyClient,
        shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    ) {
        self.client = client
        self.shell = shell
    }

    public func spawn(
        sessionName: String,
        cwd: URL,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            let window = WebPtyManagerTerminalWindow(
                sessionName: sessionName, cwd: cwd, frame: frame, client: self.client, shell: self.shell
            )
            Task {
                do {
                    let dimensions = await MainActor.run { window.attachmentDimensions }
                    let connection = try await self.client.openSession(
                        name: sessionName,
                        launch: .shell(cwd: cwd.path, shell: self.shell),
                        lifetime: .persistent,
                        columns: dimensions.columns,
                        rows: dimensions.rows,
                        createIfMissing: true,
                        clientTitle: "Workspace Terminal"
                    )
                    await MainActor.run {
                        window.attach(connection)
                        completion(.success(window))
                    }
                } catch {
                    await MainActor.run {
                        window.close()
                        completion(.failure(WebPtyManagerTerminalSpawnError.managerUnavailable("\(error)")))
                    }
                }
            }
        }
    }

    public func spawnExistingWorkspace(
        sessions: [PtySessionSummary],
        state: PtyTerminalWorkspaceState,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            guard let selectedName = state.selectedPane?.sessionName,
                  let selectedSession = sessions.first(where: { $0.name == selectedName }) else {
                completion(.failure(WebPtyManagerTerminalSpawnError.managerUnavailable("restored session missing")))
                return
            }
            let cwd = URL(fileURLWithPath: selectedSession.cwd, isDirectory: true)
            let window = WebPtyManagerTerminalWindow(
                sessionName: selectedSession.name, cwd: cwd, frame: frame, client: self.client,
                shell: selectedSession.shell, restoredWorkspace: state
            )
            Task {
                var connections: [String: PtySessionConnection] = [:]
                do {
                    let dimensions = await MainActor.run { window.attachmentDimensions }
                    for pane in state.panes {
                        guard let session = sessions.first(where: { $0.name == pane.sessionName }) else {
                            throw WebPtyManagerTerminalSpawnError.managerUnavailable("restored session missing")
                        }
                        connections[pane.paneID] = try await self.client.openSession(
                            name: session.name,
                            launch: .shell(cwd: session.cwd, shell: session.shell),
                            lifetime: .persistent,
                            columns: dimensions.columns,
                            rows: dimensions.rows,
                            createIfMissing: false,
                            clientTitle: "PTY Manager"
                        )
                    }
                    await MainActor.run {
                        window.attachWorkspace(connections)
                        completion(.success(window))
                    }
                } catch {
                    for connection in connections.values { try? await connection.detach() }
                    await MainActor.run {
                        window.close()
                        completion(.failure(WebPtyManagerTerminalSpawnError.managerUnavailable("\(error)")))
                    }
                }
            }
        }
    }

    public func spawnExistingSession(
        _ session: PtySessionSummary,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    ) {
        spawnExistingWorkspace(
            sessions: [session],
            state: PtyTerminalWorkspaceState(restoringSessionName: session.name),
            into: frame,
            completion: completion
        )
    }
}
