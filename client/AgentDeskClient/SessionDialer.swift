import CryptoKit
import Foundation
import Security

// ADR-0003 session establishment, client side. One dial attempt per call.
// Retry policy and state transitions live in PairingClient.attemptSession.

@MainActor
final class SessionDialer {
    private let randomBytes: (Int) throws -> Data
    private let now: () -> Date

    init(
        randomBytes: @escaping (Int) throws -> Data = SessionDialer.systemRandomBytes,
        now: @escaping () -> Date = Date.init
    ) {
        self.randomBytes = randomBytes
        self.now = now
    }

    func dial(
        url: URL,
        deviceFingerprint: DeviceFingerprint,
        sessionToken: SessionToken,
        hostPublicKey: Data,
        deviceKey: DeviceSigningKeyProviding,
        urlSession: URLSession
    ) async throws -> SessionHandshakeOutcome {
        let hostPub: P256.Signing.PublicKey
        do {
            hostPub = try P256.Signing.PublicKey(x963Representation: hostPublicKey)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        let hostFingerprint = hostPub.agentDeskFingerprint

        let task = urlSession.webSocketTask(with: url)
        task.resume()

        var success = false
        defer { if !success { task.cancel(with: .normalClosure, reason: nil) } }

        let clientNonce = try randomBytes(32)
        let initMessage = SessionInit(
            deviceFingerprint: deviceFingerprint,
            sessionToken: sessionToken,
            clientNonce: clientNonce
        )
        try await send(initMessage, on: task)

        let challenge = try await receive(SessionChallenge.self, expectedType: "session-challenge", on: task)
        let signingInput = SessionSigning.canonicalInput(
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint
        )
        let hostSig: P256.Signing.ECDSASignature
        do {
            hostSig = try P256.Signing.ECDSASignature(rawRepresentation: challenge.hostSignature)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        guard hostPub.isValidSignature(hostSig, for: signingInput) else {
            throw SessionRejected(reason: .badSignature)
        }

        let clientSignature = try deviceKey.signature(for: signingInput).rawRepresentation
        try await send(SessionProof(clientSignature: clientSignature), on: task)

        let ready = try await receive(SessionReady.self, expectedType: "session-ready", on: task)
        let inputCapability = InputCapabilityGrant(
            sessionId: ready.sessionId,
            inputCapability: ready.inputCapability,
            inputCapabilityExpiresAt: ready.inputCapabilityExpiresAt
        )

        let channel = WebSocketSignalingChannel(
            sender: { frame in
                let data = try JSONEncoder().encode(frame)
                guard let text = String(data: data, encoding: .utf8) else {
                    throw SessionRejected(reason: .malformed)
                }
                try await task.send(.string(text))
            },
            capabilityRequestSender: { request in
                let data = try JSONEncoder().encode(request)
                guard let text = String(data: data, encoding: .utf8) else {
                    throw SessionRejected(reason: .malformed)
                }
                try await task.send(.string(text))
            },
            closer: {
                task.cancel(with: .normalClosure, reason: nil)
            }
        )

        // Background receive loop. Exits when the task closes or yields a
        // non-decodable frame. Closing the channel on exit propagates the
        // end-of-stream signal to consumers.
        Task.detached { [task, channel] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    let data: Data
                    switch message {
                    case .data(let bytes): data = bytes
                    case .string(let text): data = Data(text.utf8)
                    @unknown default:
                        channel.close()
                        return
                    }
                    if let frame = try? JSONDecoder().decode(WebRTCSignalingFrame.self, from: data) {
                        channel.deliver(frame)
                    } else if let grant = try? JSONDecoder().decode(InputCapabilityGrant.self, from: data),
                              grant.type == "input-capability-grant" {
                        channel.deliver(grant)
                    } else if let rejected = try? JSONDecoder().decode(SessionRejected.self, from: data),
                              rejected.type == "session-rejected" {
                        channel.deliver(rejected)
                        channel.close()
                        return
                    } else {
                        channel.close()
                        return
                    }
                } catch {
                    channel.close()
                    return
                }
            }
        }

        success = true
        return SessionHandshakeOutcome(
            active: ActiveSession(
                sessionId: ready.sessionId,
                deviceFingerprint: deviceFingerprint,
                establishedAt: Int(now().timeIntervalSince1970)
            ),
            signaling: channel,
            inputCapability: inputCapability
        )
    }

    private func send<T: Encodable>(_ message: T, on task: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw SessionRejected(reason: .malformed)
        }
        try await task.send(.string(text))
    }

    private func receive<T: Decodable>(
        _ type: T.Type,
        expectedType: String,
        on task: URLSessionWebSocketTask
    ) async throws -> T {
        let message = try await task.receive()
        let data: Data
        switch message {
        case .data(let bytes):
            data = bytes
        case .string(let text):
            data = Data(text.utf8)
        @unknown default:
            throw SessionRejected(reason: .malformed)
        }
        let envelope = try Self.decodeEnvelope(from: data)
        if envelope.type == expectedType {
            do {
                return try JSONDecoder().decode(type, from: data)
            } catch {
                throw SessionRejected(reason: .malformed)
            }
        }
        if envelope.type == "session-rejected" {
            if let rejected = try? JSONDecoder().decode(SessionRejected.self, from: data) {
                throw rejected
            }
            throw SessionRejected(reason: .malformed)
        }
        throw SessionRejected(reason: .malformed)
    }

    private static func decodeEnvelope(from data: Data) throws -> Envelope {
        do {
            return try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            throw SessionRejected(reason: .malformed)
        }
    }

    private struct Envelope: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }

    nonisolated static func systemRandomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }
}
