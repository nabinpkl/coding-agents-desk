import AgentDeskWire
import Foundation
import KeyboardDictation

enum KeyboardDictationCoordinatorError: LocalizedError {
    case hostUnavailable
    case staleCommand
    case invalidTransition
    case audioQueueOverflow
    case audioQueueClosed
    case requestTimedOut

    var errorDescription: String? {
        switch self {
        case .hostUnavailable:
            "Connect AgentDesk to the paired Mac before activating keyboard dictation."
        case .staleCommand:
            "The keyboard command belongs to an older AgentDesk session."
        case .invalidTransition:
            "Keyboard dictation received a command in the wrong state."
        case .audioQueueOverflow:
            "The Mac connection could not keep up with microphone audio."
        case .audioQueueClosed:
            "The keyboard audio queue closed."
        case .requestTimedOut:
            "The Mac did not answer the keyboard dictation request in time."
        }
    }
}

@MainActor
final class KeyboardDictationCoordinator {
    typealias TransportProvider = @MainActor () -> QuicSessionClientTransport?

    var onSnapshotChange: ((KeyboardDictationServiceSnapshot) -> Void)?
    var onTurnedOff: (() -> Void)?

    private let store: KeyboardDictationStore
    private let audioCapture = KeyboardDictationAudioCapture()
    private let frameQueue = KeyboardDictationFrameQueue()
    private struct PendingREST {
        var nextSequence = 0
        var status: Int?
        var body = Data()
        let continuation: CheckedContinuation<(Int, Data), Error>
    }

    private var commandObservation: KeyboardDictationNotificationObservation?
    private var lane: VoiceLaneClient?
    private weak var transport: QuicSessionClientTransport?
    private var snapshot = KeyboardDictationServiceSnapshot.inactive
    private var generationID: UUID?
    private var currentSessionID: UUID?
    private var socketOpenRequestID: String?
    private var socketOpenContinuation: CheckedContinuation<Void, Error>?
    private var socketOpenTimeoutTask: Task<Void, Never>?
    private var armingTask: Task<Void, Never>?
    private var commandTask: Task<Void, Never>?
    private var pendingREST: [String: PendingREST] = [:]
    private var restTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var lastPublishedMeterAt = ContinuousClock.now

    var isArmed: Bool {
        generationID != nil && audioCapture.isArmed && lane != nil
    }

    var currentSnapshot: KeyboardDictationServiceSnapshot {
        snapshot
    }

    init(store: KeyboardDictationStore) {
        self.store = store
        snapshot = (try? store.serviceSnapshot()) ?? .inactive
        commandObservation = KeyboardDictationNotificationObservation(
            name: KeyboardDictationNotification.command
        ) { [weak self] in
            Task { @MainActor in
                self?.consumePendingCommand()
            }
        }
        audioCapture.onFrame = { [weak self] frame in
            guard let self else { return }
            Task {
                do {
                    try await self.frameQueue.enqueue(frame)
                } catch {
                    await MainActor.run {
                        guard self.currentSessionID
                                == frame.captureSessionID,
                              self.generationID != nil
                        else {
                            return
                        }
                        self.failCurrentTake(error)
                    }
                }
            }
        }
        audioCapture.onMeter = { [weak self] captureSessionID, level in
            Task { @MainActor in
                guard let self,
                      KeyboardDictationLifecyclePolicy
                          .acceptsCaptureCallback(
                              captureSessionID: captureSessionID,
                              activeSessionID: self.currentSessionID
                          )
                else {
                    return
                }
                self.publishMeter(level)
            }
        }
        audioCapture.onCaptureFailure = {
            [weak self] captureSessionID, error in
            Task { @MainActor in
                guard let self else { return }
                guard KeyboardDictationLifecyclePolicy
                    .acceptsCaptureCallback(
                        captureSessionID: captureSessionID,
                        activeSessionID: self.currentSessionID
                    ),
                    self.generationID != nil
                else {
                    return
                }
                self.failCurrentTake(error)
            }
        }
        audioCapture.onServiceFailure = { [weak self] error in
            Task { @MainActor in
                guard let self, self.generationID != nil else { return }
                self.failService(error)
            }
        }
    }

    convenience init() throws {
        try self.init(store: KeyboardDictationStore(
            appGroupIdentifier: KeyboardDictationContract
                .appGroupIdentifier()
        ))
    }

    func arm(transportProvider: @escaping TransportProvider) {
        guard generationID == nil else { return }
        let generationID = UUID()
        let unresolvedSessionID = Self.unresolvedSessionID(from: snapshot)
        self.generationID = generationID
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: .arming
        ))
        armingTask?.cancel()
        armingTask = Task { [weak self] in
            guard let self else { return }
            defer { armingTask = nil }
            do {
                let transport = try await waitForTransport(
                    provider: transportProvider
                )
                try await audioCapture.arm()
                guard self.generationID == generationID,
                      !Task.isCancelled
                else {
                    audioCapture.disarm()
                    return
                }
                let lane = try await transport.openVoiceLane {
                    [weak self] message in
                    guard let self,
                          KeyboardDictationLifecyclePolicy
                              .acceptsLaneCallback(
                                  callbackGeneration: generationID,
                                  activeGeneration: self.generationID
                              )
                    else {
                        return
                    }
                    self.receive(message)
                }
                guard self.generationID == generationID else {
                    lane.close()
                    audioCapture.disarm()
                    return
                }
                self.transport = transport
                self.lane = lane
                if let unresolvedSessionID,
                   let recording = try await reconcile(
                       sessionID: unresolvedSessionID
                   ) {
                    publish(KeyboardDictationServiceSnapshot(
                        generationID: generationID,
                        phase: .completed,
                        captureSessionID: unresolvedSessionID,
                        finalTranscript: recording.transcript,
                        recordingID: recording.id
                    ))
                } else {
                    publish(KeyboardDictationServiceSnapshot(
                        generationID: generationID,
                        phase: .ready
                    ))
                }
                consumePendingCommand()
            } catch is CancellationError {
                return
            } catch {
                failService(error)
            }
        }
    }

    func turnOff(acknowledging commandID: UUID? = nil) {
        armingTask?.cancel()
        armingTask = nil
        commandTask?.cancel()
        commandTask = nil
        if let sessionID = currentSessionID {
            Task { [lane] in
                try? await lane?.send(.socketClose(
                    recordingSessionID: sessionID.uuidString
                ))
            }
        }
        currentSessionID = nil
        socketOpenContinuation?.resume(
            throwing: KeyboardDictationCoordinatorError.audioQueueClosed
        )
        socketOpenTimeoutTask?.cancel()
        socketOpenTimeoutTask = nil
        socketOpenContinuation = nil
        socketOpenRequestID = nil
        let pendingREST = self.pendingREST
        self.pendingREST.removeAll()
        for request in pendingREST.values {
            request.continuation.resume(
                throwing: KeyboardDictationCoordinatorError.audioQueueClosed
            )
        }
        for task in restTimeoutTasks.values {
            task.cancel()
        }
        restTimeoutTasks.removeAll()
        Task {
            await frameQueue.cancel(
                KeyboardDictationCoordinatorError.audioQueueClosed
            )
        }
        audioCapture.disarm()
        lane?.close()
        lane = nil
        transport = nil
        generationID = nil
        publish(KeyboardDictationServiceSnapshot(
            generationID: nil,
            phase: .inactive,
            acknowledgedCommandID: commandID
        ))
        onTurnedOff?()
    }

    private func waitForTransport(
        provider: @escaping TransportProvider
    ) async throws -> QuicSessionClientTransport {
        for _ in 0..<20 {
            if let transport = provider() {
                return transport
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw KeyboardDictationCoordinatorError.hostUnavailable
    }

    private func consumePendingCommand() {
        guard commandTask == nil else { return }
        do {
            guard let command = try store.pendingCommand() else { return }
            guard command.generationID == generationID else {
                return
            }
            guard snapshot.acknowledgedCommandID != command.id else {
                return
            }
            commandTask = Task { [weak self] in
                guard let self else { return }
                defer {
                    commandTask = nil
                    consumePendingCommand()
                }
                do {
                    try await handle(command)
                } catch {
                    failCurrentTake(error, acknowledging: command.id)
                }
            }
        } catch {
            failService(error)
        }
    }

    private func handle(_ command: KeyboardDictationCommand) async throws {
        switch command.kind {
        case .ping:
            acknowledge(command.id)
        case .start:
            try await startCapture(acknowledging: command.id)
        case .stop:
            try await stopCapture(acknowledging: command.id)
        case .dismissResult:
            guard let generationID else {
                throw KeyboardDictationCoordinatorError.staleCommand
            }
            publish(KeyboardDictationServiceSnapshot(
                generationID: generationID,
                phase: .ready,
                acknowledgedCommandID: command.id
            ))
        case .turnOff:
            turnOff(acknowledging: command.id)
        }
    }

    private func startCapture(acknowledging commandID: UUID) async throws {
        guard let lane, let generationID,
              [.ready, .completed, .failed].contains(snapshot.phase)
        else {
            throw KeyboardDictationCoordinatorError.invalidTransition
        }
        let sessionID = UUID()
        let requestID = UUID().uuidString
        currentSessionID = sessionID
        socketOpenRequestID = requestID
        try await withCheckedThrowingContinuation { continuation in
            socketOpenContinuation = continuation
            socketOpenTimeoutTask?.cancel()
            socketOpenTimeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self,
                          self.socketOpenRequestID == requestID
                    else {
                        return
                    }
                    self.socketOpenRequestID = nil
                    self.socketOpenContinuation?.resume(
                        throwing:
                            KeyboardDictationCoordinatorError.requestTimedOut
                    )
                    self.socketOpenContinuation = nil
                    self.socketOpenTimeoutTask = nil
                }
            }
            Task {
                do {
                    try await lane.send(.socketOpen(
                        requestID: requestID,
                        recordingSessionID: sessionID.uuidString
                    ))
                } catch {
                    await MainActor.run {
                        guard KeyboardDictationLifecyclePolicy
                            .acceptsSocketCompletion(
                                requestID: requestID,
                                activeRequestID: self.socketOpenRequestID
                            )
                        else {
                            return
                        }
                        self.socketOpenRequestID = nil
                        self.socketOpenContinuation?.resume(throwing: error)
                        self.socketOpenContinuation = nil
                        self.socketOpenTimeoutTask?.cancel()
                        self.socketOpenTimeoutTask = nil
                    }
                }
            }
        }
        try await lane.send(.socketMessage(
            recordingSessionID: sessionID.uuidString,
            json: try Self.json(KeyboardVoiceSessionStart())
        ))
        try await frameQueue.reset(
            captureSessionID: sessionID
        ) { [weak self] frame in
            guard let self else {
                throw KeyboardDictationCoordinatorError.audioQueueClosed
            }
            try await self.send(frame, sessionID: sessionID)
        }
        try audioCapture.beginCapture(sessionID: sessionID)
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: .recording,
            captureSessionID: sessionID,
            acknowledgedCommandID: commandID
        ))
    }

    private func stopCapture(acknowledging commandID: UUID) async throws {
        guard snapshot.phase == .recording,
              let lane,
              let generationID,
              let sessionID = currentSessionID
        else {
            throw KeyboardDictationCoordinatorError.invalidTransition
        }
        let lastSequence = audioCapture.stopCapture()
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: .saving,
            captureSessionID: sessionID,
            acknowledgedCommandID: commandID
        ))
        try await frameQueue.flush(through: lastSequence)
        try await lane.send(.socketMessage(
            recordingSessionID: sessionID.uuidString,
            json: try Self.json(KeyboardVoiceSessionStop())
        ))
    }

    private func send(
        _ frame: KeyboardDictationPCMFrame,
        sessionID: UUID
    ) async throws {
        guard let lane, currentSessionID == sessionID else {
            throw KeyboardDictationCoordinatorError.audioQueueClosed
        }
        try await lane.send(.socketMessage(
            recordingSessionID: sessionID.uuidString,
            json: try Self.json(KeyboardVoiceAudioFrame(
                pcm: frame.samples.base64EncodedString()
            ))
        ))
    }

    private func receive(_ message: VoiceLaneHostMessage) {
        switch message {
        case .socketOpened(let requestID, let sessionID):
            guard requestID == socketOpenRequestID,
                  sessionID == currentSessionID?.uuidString
            else {
                return
            }
            socketOpenRequestID = nil
            socketOpenTimeoutTask?.cancel()
            socketOpenTimeoutTask = nil
            socketOpenContinuation?.resume()
            socketOpenContinuation = nil
        case .socketMessage(let sessionID, let json):
            guard sessionID == currentSessionID?.uuidString else { return }
            receiveVoiceJSON(json)
        case .socketClosed(let sessionID, let reason):
            guard sessionID == currentSessionID?.uuidString else { return }
            if snapshot.phase != .completed {
                failCurrentTake(
                    VoiceLaneClientError.closed,
                    detail: reason
                )
            }
        case .error(let requestID, let sessionID, let code, let message):
            if let requestID,
               let request = pendingREST.removeValue(forKey: requestID) {
                restTimeoutTasks.removeValue(forKey: requestID)?.cancel()
                request.continuation.resume(
                    throwing: NSError(
                        domain: "KeyboardDictationVoiceREST",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: message]
                    )
                )
                return
            }
            if requestID == socketOpenRequestID {
                socketOpenRequestID = nil
                socketOpenTimeoutTask?.cancel()
                socketOpenTimeoutTask = nil
                socketOpenContinuation?.resume(
                    throwing: NSError(
                        domain: "KeyboardDictationVoiceLane",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: message]
                    )
                )
                socketOpenContinuation = nil
                return
            }
            if [.transportLost, .sidecarUnavailable, .unsupportedVersion]
                .contains(code)
            {
                failService(
                    NSError(
                        domain: "KeyboardDictationVoiceLane",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: message]
                    )
                )
                return
            }
            if sessionID == nil || sessionID == currentSessionID?.uuidString {
                failCurrentTake(
                    VoiceLaneClientError.closed,
                    detail: message
                )
            }
        case .rest(let response):
            receiveREST(response)
        case .ready:
            break
        }
    }

    private func receiveVoiceJSON(_ json: String) {
        do {
            let message = try JSONDecoder().decode(
                KeyboardVoiceServerMessage.self,
                from: Data(json.utf8)
            )
            switch message.type {
            case "partialTranscript":
                updateRecordingSnapshot(partialTranscript: message.text)
            case "meter":
                if let rms = message.rms {
                    publishMeter(min(max(rms * 12, 0), 1))
                }
            case "sessionProgress":
                guard let stage = message.stage,
                      [.saving, .transcribing, .analyzing].contains(stage)
                else {
                    return
                }
                updateRecordingSnapshot(phase: stage)
            case "sessionError":
                failCurrentTake(NSError(
                    domain: "KeyboardDictationSidecar",
                    code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            message.message ?? "Keyboard dictation failed."
                    ]
                ))
            case "sessionComplete":
                guard let generationID,
                      let recording = message.recording,
                      let sessionID = currentSessionID,
                      recording.clientSessionID == sessionID.uuidString
                else {
                    throw KeyboardDictationCoordinatorError.invalidTransition
                }
                currentSessionID = nil
                publish(KeyboardDictationServiceSnapshot(
                    generationID: generationID,
                    phase: .completed,
                    captureSessionID: sessionID,
                    finalTranscript: recording.transcript,
                    recordingID: recording.id
                ))
            default:
                break
            }
        } catch {
            failCurrentTake(error)
        }
    }

    private func updateRecordingSnapshot(
        phase: KeyboardDictationServicePhase? = nil,
        partialTranscript: String? = nil
    ) {
        guard let generationID else { return }
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: phase ?? snapshot.phase,
            captureSessionID: currentSessionID,
            acknowledgedCommandID: snapshot.acknowledgedCommandID,
            partialTranscript: partialTranscript
                ?? snapshot.partialTranscript,
            meterLevel: snapshot.meterLevel
        ))
    }

    private func publishMeter(_ level: Float) {
        guard snapshot.phase == .recording,
              lastPublishedMeterAt.duration(to: .now)
                >= .milliseconds(100),
              let generationID
        else {
            return
        }
        lastPublishedMeterAt = .now
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: .recording,
            captureSessionID: currentSessionID,
            acknowledgedCommandID: snapshot.acknowledgedCommandID,
            partialTranscript: snapshot.partialTranscript,
            meterLevel: min(max(level, 0), 1)
        ))
    }

    private func acknowledge(_ commandID: UUID) {
        guard let generationID else { return }
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: snapshot.phase,
            captureSessionID: snapshot.captureSessionID,
            acknowledgedCommandID: commandID,
            partialTranscript: snapshot.partialTranscript,
            finalTranscript: snapshot.finalTranscript,
            recordingID: snapshot.recordingID,
            meterLevel: snapshot.meterLevel,
            errorMessage: snapshot.errorMessage
        ))
    }

    private func failCurrentTake(
        _ error: Error,
        acknowledging commandID: UUID? = nil,
        detail: String? = nil
    ) {
        let sessionID = currentSessionID
        let hadCapture = snapshot.phase == .recording
        if hadCapture {
            _ = audioCapture.stopCapture()
        }
        currentSessionID = nil
        socketOpenContinuation?.resume(throwing: error)
        socketOpenTimeoutTask?.cancel()
        socketOpenTimeoutTask = nil
        socketOpenContinuation = nil
        socketOpenRequestID = nil
        if let sessionID {
            Task { [lane] in
                try? await lane?.send(.socketClose(
                    recordingSessionID: sessionID.uuidString
                ))
            }
        }
        guard let generationID else {
            failService(error)
            return
        }
        publish(KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: .failed,
            captureSessionID: sessionID,
            acknowledgedCommandID: commandID
                ?? snapshot.acknowledgedCommandID,
            errorMessage: detail ?? error.localizedDescription
        ))
    }

    private func failService(_ error: Error) {
        let sessionID = currentSessionID ?? snapshot.captureSessionID
        currentSessionID = nil
        socketOpenContinuation?.resume(throwing: error)
        socketOpenTimeoutTask?.cancel()
        socketOpenTimeoutTask = nil
        socketOpenContinuation = nil
        socketOpenRequestID = nil
        let pendingREST = self.pendingREST
        self.pendingREST.removeAll()
        for request in pendingREST.values {
            request.continuation.resume(throwing: error)
        }
        for task in restTimeoutTasks.values {
            task.cancel()
        }
        restTimeoutTasks.removeAll()
        Task {
            await frameQueue.cancel(error)
        }
        _ = audioCapture.stopCapture()
        audioCapture.disarm()
        lane?.close()
        lane = nil
        transport = nil
        generationID = nil
        publish(KeyboardDictationServiceSnapshot(
            generationID: nil,
            phase: .failed,
            captureSessionID: sessionID,
            errorMessage: error.localizedDescription
        ))
        onTurnedOff?()
    }

    private func publish(_ snapshot: KeyboardDictationServiceSnapshot) {
        self.snapshot = snapshot
        do {
            try store.saveServiceSnapshot(snapshot)
            KeyboardDictationNotification.post(
                KeyboardDictationNotification.service
            )
        } catch {
            ClientDiagnostics.shared.record(
                type: "keyboardDictationStateWriteFailed",
                fields: ["error": String(describing: error)],
                level: .error
            )
        }
        onSnapshotChange?(snapshot)
    }

    private static func json<Value: Encodable>(_ value: Value) throws -> String {
        let data = try JSONEncoder().encode(value)
        guard let json = String(data: data, encoding: .utf8) else {
            throw KeyboardDictationCoordinatorError.invalidTransition
        }
        return json
    }

    private func reconcile(
        sessionID: UUID
    ) async throws -> KeyboardVoiceServerMessage.Recording? {
        for attempt in 0..<20 {
            let (status, data) = try await performREST(
                path: "/recordings/client-session/\(sessionID.uuidString)"
            )
            if status == 404 {
                if attempt < 19 {
                    try await Task.sleep(for: .milliseconds(500))
                    continue
                }
                return nil
            }
            guard (200..<300).contains(status) else {
                throw NSError(
                    domain: "KeyboardDictationVoiceREST",
                    code: status,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "The Mac could not reconcile the prior dictation."
                    ]
                )
            }
            return try JSONDecoder().decode(
                KeyboardVoiceServerMessage.Recording.self,
                from: data
            )
        }
        return nil
    }

    private func performREST(path: String) async throws -> (Int, Data) {
        guard let lane else {
            throw VoiceLaneClientError.closed
        }
        let requestID = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            pendingREST[requestID] = PendingREST(
                continuation: continuation
            )
            restTimeoutTasks[requestID] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self,
                          let request = self.pendingREST.removeValue(
                              forKey: requestID
                          )
                    else {
                        return
                    }
                    self.restTimeoutTasks.removeValue(
                        forKey: requestID
                    )?.cancel()
                    request.continuation.resume(
                        throwing:
                            KeyboardDictationCoordinatorError.requestTimedOut
                    )
                }
            }
            Task {
                do {
                    try await lane.send(.rest(VoiceRESTRequest(
                        requestID: requestID,
                        method: .get,
                        path: path
                    )))
                } catch {
                    await MainActor.run {
                        self.pendingREST
                            .removeValue(forKey: requestID)?
                            .continuation
                            .resume(throwing: error)
                        self.restTimeoutTasks
                            .removeValue(forKey: requestID)?
                            .cancel()
                    }
                }
            }
        }
    }

    private func receiveREST(_ response: VoiceRESTResponse) {
        guard var request = pendingREST[response.requestID] else { return }
        guard response.sequence == request.nextSequence else {
            pendingREST.removeValue(forKey: response.requestID)
            restTimeoutTasks
                .removeValue(forKey: response.requestID)?
                .cancel()
            request.continuation.resume(
                throwing: KeyboardDictationCoordinatorError.invalidTransition
            )
            return
        }
        request.status = response.status
        request.body.append(response.body)
        request.nextSequence += 1
        if response.isFinal {
            pendingREST.removeValue(forKey: response.requestID)
            restTimeoutTasks
                .removeValue(forKey: response.requestID)?
                .cancel()
            request.continuation.resume(returning: (
                request.status ?? response.status,
                request.body
            ))
        } else {
            pendingREST[response.requestID] = request
        }
    }

    private static func unresolvedSessionID(
        from snapshot: KeyboardDictationServiceSnapshot
    ) -> UUID? {
        switch snapshot.phase {
        case .recording, .saving, .transcribing, .analyzing, .failed:
            snapshot.captureSessionID
        case .inactive, .arming, .ready, .completed:
            nil
        }
    }
}
