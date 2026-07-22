import Foundation
import PtyClientSwift

public protocol PtyTerminalConnection: AnyObject {
    func events() -> AsyncThrowingStream<PtySessionEvent, Error>
    func sendInput(_ data: Data) async throws
    func updateViewerState(
        sequence: UInt64,
        active: Bool,
        claim: Bool,
        columns: UInt32,
        rows: UInt32
    ) async throws
    func requestCheckpoint(lastAppliedRevision: UInt64) async throws
    func detach() async throws
}

extension PtySessionConnection: PtyTerminalConnection {}

public extension PtyTerminalConnection {
    func requestCheckpoint(lastAppliedRevision: UInt64) async throws {}
}

public enum PtyTerminalSynchronizationError: Error, Equatable, Sendable {
    case invalidCheckpoint(String)
    case invalidRevision(expected: UInt64, received: UInt64)
}

public enum PtyTerminalSessionTermination: Equatable, Sendable {
    case exited(status: Int32)
}

@MainActor
public protocol PtyTerminalRenderer: AnyObject {
    func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint)
    func feedCheckpointChunk(_ data: Data)
    func endCheckpoint(_ checkpoint: PtyTerminalCheckpoint)
    func feedOutput(_ data: Data, revision: UInt64)
    func updateViewportStatus(_ status: PtyTerminalViewportStatus)
    func feedStatus(_ text: String)
    func closeAfterManagerDetach()
}

public extension PtyTerminalRenderer {
    func updateViewportStatus(_ status: PtyTerminalViewportStatus) {}
}

@MainActor
public final class PtyTerminalSessionDriver {
    private static let maximumColumns: UInt32 = 512
    private static let maximumRows: UInt32 = 256
    private static let maximumCheckpointBytes: UInt64 = 16 * 1024 * 1024
    private static let maximumCheckpointChunkBytes = 512 * 1024
    private static let maximumCheckpointChunks: UInt32 = 256

    private let connection: PtyTerminalConnection
    private weak var renderer: PtyTerminalRenderer?
    private let onTermination: (PtyTerminalSessionTermination) -> Void
    private let onError: (Error) -> Void
    private var eventsTask: Task<Void, Never>?
    private var eventsGeneration: UInt64 = 0
    private var didReportTermination = false
    private var appliedRevision: UInt64 = 0
    private var awaitingCheckpoint = true
    private var replacementRequested = false
    private var pendingCheckpoint: PendingCheckpoint?
    private var viewerSequence: UInt64 = 0
    private var viewerDimensions = PtyTerminalDimensions.bootstrap
    private var commandTask: Task<Void, Never>?

    private struct PendingCheckpoint {
        let metadata: PtyTerminalCheckpoint
        var nextChunkIndex: UInt32 = 0
        var receivedBytes: UInt64 = 0
    }

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

    public func sendInput(_ data: Data, viewerDimensions: PtyTerminalDimensions) {
        self.viewerDimensions = viewerDimensions
        let sequence = nextViewerSequence()
        let dimensions = viewerDimensions
        enqueueCommand { connection in
            try await connection.updateViewerState(
                sequence: sequence,
                active: true,
                claim: true,
                columns: dimensions.columns,
                rows: dimensions.rows
            )
            try await connection.sendInput(data)
        }
    }

    public func updateViewerState(
        active: Bool,
        claim: Bool,
        dimensions: PtyTerminalDimensions
    ) {
        viewerDimensions = dimensions
        let sequence = nextViewerSequence()
        enqueueCommand { connection in
            try await connection.updateViewerState(
                sequence: sequence,
                active: active,
                claim: claim,
                columns: dimensions.columns,
                rows: dimensions.rows
            )
        }
    }

    public func stop() {
        eventsGeneration &+= 1
        eventsTask?.cancel()
        eventsTask = nil
    }

    public func detach() {
        stop()
        let sequence = nextViewerSequence()
        let dimensions = viewerDimensions
        enqueueCommand(reportErrors: false) { connection in
            try await connection.updateViewerState(
                sequence: sequence,
                active: false,
                claim: false,
                columns: dimensions.columns,
                rows: dimensions.rows
            )
            try await connection.detach()
        }
    }

    private func handle(_ event: PtySessionEvent, eventsGeneration: UInt64) {
        guard eventsGeneration == self.eventsGeneration else { return }
        switch event {
        case .attached:
            break
        case .checkpointBegan(let checkpoint):
            beginCheckpoint(checkpoint)
        case .checkpointChunk(let checkpointID, let index, let data):
            appendCheckpointChunk(checkpointID: checkpointID, index: index, data: data)
        case .checkpointEnded(let checkpointID, let revision):
            finishCheckpoint(checkpointID: checkpointID, revision: revision)
        case .output(let data, let revision):
            applyOutput(data, revision: revision)
        case .viewportStatus(let status):
            renderer?.updateViewportStatus(status)
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

    private func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        guard checkpoint.checkpointID > 0,
              checkpoint.revision > 0,
              checkpoint.revision >= appliedRevision,
              (1...Self.maximumColumns).contains(checkpoint.columns),
              (1...Self.maximumRows).contains(checkpoint.rows),
              (1...Self.maximumCheckpointBytes).contains(checkpoint.totalBytes),
              (1...Self.maximumCheckpointChunks).contains(checkpoint.chunkCount) else {
            failSynchronization(.invalidCheckpoint("invalid checkpoint header"))
            return
        }
        pendingCheckpoint = PendingCheckpoint(metadata: checkpoint)
        awaitingCheckpoint = true
        renderer?.beginCheckpoint(checkpoint)
    }

    private func appendCheckpointChunk(checkpointID: UInt64, index: UInt32, data: Data) {
        guard pendingCheckpoint != nil || !replacementRequested else { return }
        guard var pending = pendingCheckpoint,
              pending.metadata.checkpointID == checkpointID,
              pending.nextChunkIndex == index,
              !data.isEmpty,
              data.count <= Self.maximumCheckpointChunkBytes,
              pending.receivedBytes <= UInt64.max - UInt64(data.count),
              pending.receivedBytes + UInt64(data.count) <= pending.metadata.totalBytes else {
            failSynchronization(.invalidCheckpoint("checkpoint chunk mismatch"))
            return
        }
        pending.nextChunkIndex += 1
        pending.receivedBytes += UInt64(data.count)
        pendingCheckpoint = pending
        renderer?.feedCheckpointChunk(data)
    }

    private func finishCheckpoint(checkpointID: UInt64, revision: UInt64) {
        guard pendingCheckpoint != nil || !replacementRequested else { return }
        guard let pending = pendingCheckpoint,
              pending.metadata.checkpointID == checkpointID,
              pending.metadata.revision == revision,
              pending.nextChunkIndex == pending.metadata.chunkCount,
              pending.receivedBytes == pending.metadata.totalBytes else {
            failSynchronization(.invalidCheckpoint("checkpoint completion mismatch"))
            return
        }
        pendingCheckpoint = nil
        appliedRevision = revision
        awaitingCheckpoint = false
        replacementRequested = false
        renderer?.endCheckpoint(pending.metadata)
    }

    private func applyOutput(_ data: Data, revision: UInt64) {
        guard !awaitingCheckpoint, pendingCheckpoint == nil else { return }
        let expected = appliedRevision &+ 1
        guard appliedRevision < UInt64.max, revision == expected else {
            failSynchronization(.invalidRevision(expected: expected, received: revision))
            return
        }
        appliedRevision = revision
        renderer?.feedOutput(data, revision: revision)
    }

    private func failSynchronization(_ error: PtyTerminalSynchronizationError) {
        pendingCheckpoint = nil
        awaitingCheckpoint = true
        renderer?.feedStatus("\r\n[terminal synchronizing]\r\n")
        onError(error)
        guard !replacementRequested else { return }
        replacementRequested = true
        let lastAppliedRevision = appliedRevision
        Task { [connection, onError] in
            do {
                try await connection.requestCheckpoint(lastAppliedRevision: lastAppliedRevision)
            } catch {
                await MainActor.run { onError(error) }
            }
        }
    }

    private func handle(_ error: Error, eventsGeneration: UInt64) {
        guard eventsGeneration == self.eventsGeneration else { return }
        renderer?.feedStatus("\r\n[pty manager error: \(error)]\r\n")
        onError(error)
    }

    private func enqueueCommand(
        reportErrors: Bool = true,
        _ operation: @escaping @Sendable (PtyTerminalConnection) async throws -> Void
    ) {
        let previous = commandTask
        let connection = self.connection
        let onError = self.onError
        commandTask = Task {
            await previous?.value
            do {
                try await operation(connection)
            } catch {
                guard reportErrors else { return }
                await MainActor.run { onError(error) }
            }
        }
    }

    private func nextViewerSequence() -> UInt64 {
        precondition(viewerSequence < UInt64.max, "terminal viewer sequence exhausted")
        viewerSequence += 1
        return viewerSequence
    }
}
