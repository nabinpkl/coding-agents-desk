import Foundation
import PtyClientSwift

public protocol PtyTerminalConnection: AnyObject {
    func events() -> AsyncThrowingStream<PtySessionEvent, Error>
    func sendInput(_ data: Data) async throws
    func resize(columns: UInt32, rows: UInt32) async throws
    func detach() async throws
}

extension PtySessionConnection: PtyTerminalConnection {}

@MainActor
public protocol PtyTerminalRenderer: AnyObject {
    func feedOutput(_ data: Data)
    func feedStatus(_ text: String)
    func closeAfterManagerDetach()
}

@MainActor
public final class PtyTerminalSessionDriver {
    private let connection: PtyTerminalConnection
    private weak var renderer: PtyTerminalRenderer?
    private let onError: (Error) -> Void
    private var eventsTask: Task<Void, Never>?

    public init(
        connection: PtyTerminalConnection,
        renderer: PtyTerminalRenderer,
        onError: @escaping (Error) -> Void = { _ in }
    ) {
        self.connection = connection
        self.renderer = renderer
        self.onError = onError
    }

    public func start() {
        guard eventsTask == nil else { return }
        eventsTask = Task { [weak self, connection] in
            do {
                for try await event in connection.events() {
                    await MainActor.run {
                        self?.handle(event)
                    }
                }
            } catch is CancellationError {
            } catch {
                await MainActor.run {
                    self?.renderer?.feedStatus("\r\n[pty manager error: \(error)]\r\n")
                    self?.onError(error)
                }
            }
        }
    }

    public func sendInput(_ data: Data) {
        Task { [connection, onError] in
            do {
                try await connection.sendInput(data)
            } catch {
                await MainActor.run {
                    onError(error)
                }
            }
        }
    }

    public func resize(columns: Int, rows: Int) {
        Task { [connection, onError] in
            do {
                try await connection.resize(columns: UInt32(columns), rows: UInt32(rows))
            } catch {
                await MainActor.run {
                    onError(error)
                }
            }
        }
    }

    public func stop() {
        eventsTask?.cancel()
        eventsTask = nil
    }

    public func detach() {
        stop()
        Task { [connection] in
            try? await connection.detach()
        }
    }

    private func handle(_ event: PtySessionEvent) {
        switch event {
        case .attached:
            break
        case .output(let data):
            renderer?.feedOutput(data)
        case .detachedByManager:
            renderer?.closeAfterManagerDetach()
        case .exited(let status):
            renderer?.feedStatus("\r\n[session exited: \(status)]\r\n")
        case .error(let message):
            renderer?.feedStatus("\r\n[pty manager error: \(message)]\r\n")
        }
    }
}
