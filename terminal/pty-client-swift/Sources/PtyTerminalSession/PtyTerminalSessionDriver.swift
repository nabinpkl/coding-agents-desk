import Foundation
import PtyClientSwift

public protocol PtyTerminalConnection: AnyObject {
    func events() -> AsyncThrowingStream<PtySessionEvent, Error>
    func sendInput(_ data: Data) async throws
    func resize(columns: UInt32, rows: UInt32) async throws
    func detach() async throws
}

extension PtySessionConnection: PtyTerminalConnection {}

public enum PtyTerminalSessionTermination: Equatable, Sendable {
    case exited(status: Int32)
}

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
    private let onTermination: (PtyTerminalSessionTermination) -> Void
    private let onError: (Error) -> Void
    private var eventsTask: Task<Void, Never>?
    private var eventsGeneration: UInt64 = 0
    private var didReportTermination = false

    public init(
        connection: PtyTerminalConnection,
        renderer: PtyTerminalRenderer,
        onTermination: @escaping (PtyTerminalSessionTermination) -> Void = { _ in },
        onError: @escaping (Error) -> Void = { _ in }
    ) {
        self.connection = connection
        self.renderer = renderer
        self.onTermination = onTermination
        self.onError = onError
    }

    public func start() {
        guard eventsTask == nil else { return }
        eventsGeneration &+= 1
        let generation = eventsGeneration
        didReportTermination = false
        eventsTask = Task { [weak self, connection] in
            do {
                for try await event in connection.events() {
                    await MainActor.run {
                        self?.handle(event, eventsGeneration: generation)
                    }
                }
            } catch is CancellationError {
            } catch {
                await MainActor.run {
                    self?.handle(error, eventsGeneration: generation)
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
        eventsGeneration &+= 1
        eventsTask?.cancel()
        eventsTask = nil
    }

    public func detach() {
        stop()
        Task { [connection] in
            try? await connection.detach()
        }
    }

    private func handle(_ event: PtySessionEvent, eventsGeneration: UInt64) {
        guard eventsGeneration == self.eventsGeneration else { return }
        switch event {
        case .attached:
            break
        case .output(let data):
            renderer?.feedOutput(data)
        case .detachedByManager:
            renderer?.closeAfterManagerDetach()
        case .exited(let status):
            renderer?.feedStatus("\r\n[session exited: \(status)]\r\n")
            guard !didReportTermination else { return }
            didReportTermination = true
            onTermination(.exited(status: status))
        case .error(let message):
            renderer?.feedStatus("\r\n[pty manager error: \(message)]\r\n")
        }
    }

    private func handle(_ error: Error, eventsGeneration: UInt64) {
        guard eventsGeneration == self.eventsGeneration else { return }
        renderer?.feedStatus("\r\n[pty manager error: \(error)]\r\n")
        onError(error)
    }
}
