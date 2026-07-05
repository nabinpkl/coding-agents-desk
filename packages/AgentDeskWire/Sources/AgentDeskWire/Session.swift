// Session wire types (ADR-0050). Moved verbatim from the former per-app
// SharedTypes.swift; single source of truth for host and client.

import CryptoKit
import Foundation

public struct SessionToken: Codable, Equatable, Sendable {
    public let hostFingerprint: String
    public let deviceFingerprint: DeviceFingerprint
    public let issuedAt: Int
    public let signature: Data

    public enum CodingKeys: String, CodingKey {
        case hostFingerprint = "h"
        case deviceFingerprint = "d"
        case issuedAt = "i"
        case signature = "s"
    }

    public init(hostFingerprint: String, deviceFingerprint: DeviceFingerprint, issuedAt: Int, signature: Data) {
        self.hostFingerprint = hostFingerprint
        self.deviceFingerprint = deviceFingerprint
        self.issuedAt = issuedAt
        self.signature = signature
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostFingerprint = try container.decode(String.self, forKey: .hostFingerprint)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        issuedAt = try container.decode(Int.self, forKey: .issuedAt)
        signature = try Data(base64URLEncoded: container.decode(String.self, forKey: .signature))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(issuedAt, forKey: .issuedAt)
        try container.encode(signature.base64URLEncodedString(), forKey: .signature)
    }
}
public struct SessionInit: Codable, Equatable, Sendable {
    public let type: String
    public let deviceFingerprint: DeviceFingerprint
    public let sessionToken: SessionToken
    public let clientNonce: Data
    // ADR-0020: client's wire protocol version. Decode-tolerant (older peers omit
    // it and read as 1).
    public let protocolVersion: Int

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionToken = "s"
        case clientNonce = "n"
        case protocolVersion = "pv"
    }

    public init(deviceFingerprint: DeviceFingerprint, sessionToken: SessionToken, clientNonce: Data, protocolVersion: Int = WireProtocol.version) {
        self.type = "session-init"
        self.deviceFingerprint = deviceFingerprint
        self.sessionToken = sessionToken
        self.clientNonce = clientNonce
        self.protocolVersion = protocolVersion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        sessionToken = try container.decode(SessionToken.self, forKey: .sessionToken)
        clientNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientNonce))
        protocolVersion = try container.decodeIfPresent(Int.self, forKey: .protocolVersion) ?? 1
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(sessionToken, forKey: .sessionToken)
        try container.encode(clientNonce.base64URLEncodedString(), forKey: .clientNonce)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}
public struct SessionChallenge: Codable, Equatable, Sendable {
    public let type: String
    public let hostNonce: Data
    public let hostSignature: Data
    // ADR-0020: host's wire protocol version, so the client can detect a host too
    // old for it. Decode-tolerant (older peers omit it and read as 1).
    public let protocolVersion: Int

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case hostNonce = "n"
        case hostSignature = "s"
        case protocolVersion = "pv"
    }

    public init(hostNonce: Data, hostSignature: Data, protocolVersion: Int = WireProtocol.version) {
        self.type = "session-challenge"
        self.hostNonce = hostNonce
        self.hostSignature = hostSignature
        self.protocolVersion = protocolVersion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        hostNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostNonce))
        hostSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostSignature))
        protocolVersion = try container.decodeIfPresent(Int.self, forKey: .protocolVersion) ?? 1
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(hostNonce.base64URLEncodedString(), forKey: .hostNonce)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}
public struct SessionProof: Codable, Equatable, Sendable {
    public let type: String
    public let clientSignature: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case clientSignature = "s"
    }

    public init(clientSignature: Data) {
        self.type = "session-proof"
        self.clientSignature = clientSignature
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        clientSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientSignature))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(clientSignature.base64URLEncodedString(), forKey: .clientSignature)
    }
}
public struct SessionReady: Codable, Equatable, Sendable {
    public let type: String
    public let sessionId: String
    public let resumeId: Data
    public let resumeSecret: Data
    public let resumeExpiresAt: Int
    public let mediaKeySalt: Data
    public let hostSignature: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case resumeId = "rid"
        case resumeSecret = "rs"
        case resumeExpiresAt = "re"
        case mediaKeySalt = "mk"
        case hostSignature = "hs"
    }

    public init(
        sessionId: String,
        resumeId: Data,
        resumeSecret: Data,
        resumeExpiresAt: Int,
        mediaKeySalt: Data,
        hostSignature: Data
    ) {
        self.type = "session-ready"
        self.sessionId = sessionId
        self.resumeId = resumeId
        self.resumeSecret = resumeSecret
        self.resumeExpiresAt = resumeExpiresAt
        self.mediaKeySalt = mediaKeySalt
        self.hostSignature = hostSignature
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        resumeId = try Data(base64URLEncoded: container.decode(String.self, forKey: .resumeId))
        resumeSecret = try Data(base64URLEncoded: container.decode(String.self, forKey: .resumeSecret))
        resumeExpiresAt = try container.decode(Int.self, forKey: .resumeExpiresAt)
        mediaKeySalt = try Data(base64URLEncoded: container.decode(String.self, forKey: .mediaKeySalt))
        hostSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostSignature))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(resumeId.base64URLEncodedString(), forKey: .resumeId)
        try container.encode(resumeSecret.base64URLEncodedString(), forKey: .resumeSecret)
        try container.encode(resumeExpiresAt, forKey: .resumeExpiresAt)
        try container.encode(mediaKeySalt.base64URLEncodedString(), forKey: .mediaKeySalt)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
    }
}
public struct SessionResumeInit: Codable, Equatable, Sendable {
    public let type: String
    public let deviceFingerprint: DeviceFingerprint
    public let sessionId: String
    public let resumeId: Data
    public let clientNonce: Data
    public let protocolVersion: Int

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
        case resumeId = "rid"
        case clientNonce = "cn"
        case protocolVersion = "pv"
    }

    public init(
        deviceFingerprint: DeviceFingerprint,
        sessionId: String,
        resumeId: Data,
        clientNonce: Data = Data(),
        protocolVersion: Int = WireProtocol.version
    ) {
        self.type = "session-resume"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
        self.resumeId = resumeId
        self.clientNonce = clientNonce
        self.protocolVersion = protocolVersion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        resumeId = try Data(base64URLEncoded: container.decode(String.self, forKey: .resumeId))
        clientNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientNonce))
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(resumeId.base64URLEncodedString(), forKey: .resumeId)
        try container.encode(clientNonce.base64URLEncodedString(), forKey: .clientNonce)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}
public struct SessionResumeChallenge: Codable, Equatable, Sendable {
    public let type: String
    public let hostNonce: Data
    public let resumeExpiresAt: Int
    public let hostSignature: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case hostNonce = "hn"
        case resumeExpiresAt = "re"
        case hostSignature = "hs"
    }

    public init(hostNonce: Data, resumeExpiresAt: Int, hostSignature: Data) {
        self.type = "session-resume-challenge"
        self.hostNonce = hostNonce
        self.resumeExpiresAt = resumeExpiresAt
        self.hostSignature = hostSignature
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        hostNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostNonce))
        resumeExpiresAt = try container.decode(Int.self, forKey: .resumeExpiresAt)
        hostSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostSignature))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(hostNonce.base64URLEncodedString(), forKey: .hostNonce)
        try container.encode(resumeExpiresAt, forKey: .resumeExpiresAt)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
    }
}
public struct SessionResumeProof: Codable, Equatable, Sendable {
    public let type: String
    public let proof: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case proof = "p"
    }

    public init(proof: Data) {
        self.type = "session-resume-proof"
        self.proof = proof
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedType = try container.decode(String.self, forKey: .type)
        guard decodedType == "session-resume-proof" else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unexpected session resume proof type"
            )
        }
        type = decodedType
        proof = try Data(base64URLEncoded: container.decode(String.self, forKey: .proof))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(proof.base64URLEncodedString(), forKey: .proof)
    }
}
public enum SessionResumeSigning: Sendable {
    private static let domainPrefix = "agentdesk-session-resume-v2"

    public static func proof(
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int,
        secret: Data
    ) -> Data {
        let input = canonicalInput(
            sessionId: sessionId,
            deviceFingerprint: deviceFingerprint,
            resumeId: resumeId,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: protocolVersion
        )
        let code = HMAC<SHA256>.authenticationCode(
            for: input,
            using: SymmetricKey(data: secret)
        )
        return Data(code)
    }

    public static func isValid(
        _ proof: Data,
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int,
        secret: Data
    ) -> Bool {
        let input = canonicalInput(
            sessionId: sessionId,
            deviceFingerprint: deviceFingerprint,
            resumeId: resumeId,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: protocolVersion
        )
        return HMAC<SHA256>.isValidAuthenticationCode(
            proof,
            authenticating: input,
            using: SymmetricKey(data: secret)
        )
    }

    private static func canonicalInput(
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int
    ) -> Data {
        var data = Data()
        appendField(Data(domainPrefix.utf8), to: &data)
        appendField(Data(WireProtocol.sessionQuicALPN.utf8), to: &data)
        appendField(Data(sessionId.utf8), to: &data)
        appendField(Data(deviceFingerprint.rawValue.utf8), to: &data)
        appendField(resumeId, to: &data)
        appendField(clientNonce, to: &data)
        appendField(hostNonce, to: &data)
        appendField(Data(String(protocolVersion).utf8), to: &data)
        return data
    }

    public static func challengeInput(
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        resumeExpiresAt: Int,
        protocolVersion: Int,
        hostFingerprint: String
    ) -> Data {
        var data = Data()
        appendField(Data("\(domainPrefix):challenge".utf8), to: &data)
        appendField(Data(WireProtocol.sessionQuicALPN.utf8), to: &data)
        appendField(Data(sessionId.utf8), to: &data)
        appendField(Data(deviceFingerprint.rawValue.utf8), to: &data)
        appendField(resumeId, to: &data)
        appendField(clientNonce, to: &data)
        appendField(hostNonce, to: &data)
        appendField(Data(String(resumeExpiresAt).utf8), to: &data)
        appendField(Data(String(protocolVersion).utf8), to: &data)
        appendField(Data(hostFingerprint.utf8), to: &data)
        return data
    }

    public static func readyInput(
        ready: SessionReady,
        deviceFingerprint: DeviceFingerprint,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int,
        hostFingerprint: String
    ) -> Data {
        var data = Data()
        appendField(Data("\(domainPrefix):ready".utf8), to: &data)
        appendField(Data(WireProtocol.sessionQuicALPN.utf8), to: &data)
        appendField(Data(ready.sessionId.utf8), to: &data)
        appendField(Data(deviceFingerprint.rawValue.utf8), to: &data)
        appendField(ready.resumeId, to: &data)
        appendField(ready.resumeSecret, to: &data)
        appendField(Data(String(ready.resumeExpiresAt).utf8), to: &data)
        appendField(ready.mediaKeySalt, to: &data)
        appendField(clientNonce, to: &data)
        appendField(hostNonce, to: &data)
        appendField(Data(String(protocolVersion).utf8), to: &data)
        appendField(Data(hostFingerprint.utf8), to: &data)
        return data
    }

    private static func appendField(_ field: Data, to data: inout Data) {
        data.append(UInt8((field.count >> 24) & 0xff))
        data.append(UInt8((field.count >> 16) & 0xff))
        data.append(UInt8((field.count >> 8) & 0xff))
        data.append(UInt8(field.count & 0xff))
        data.append(field)
    }
}
public enum SessionRejectionReason: String, Codable, Equatable, Error, Sendable {
    case revoked
    case unknownDevice = "unknown-device"
    case replay
    case badSignature = "bad-signature"
    case malformed
    case unauthorized
    case expiredResume = "expired-resume"
    case signingKeyUnavailable = "signing-key-unavailable"
    // ADR-0020: peer's wire protocol version is incompatible; the user must
    // update the older app. Not recoverable by retrying.
    case incompatibleProtocol = "incompatible-protocol"
}
public struct SessionRejected: Codable, Equatable, Error, Sendable {
    public let type: String
    public let reason: SessionRejectionReason

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case reason = "r"
    }

    public init(reason: SessionRejectionReason) {
        self.type = "session-rejected"
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        reason = try container.decode(SessionRejectionReason.self, forKey: .reason)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(reason, forKey: .reason)
    }
}
public struct ActiveSession: Equatable, Sendable {
    public let sessionId: String
    public let deviceFingerprint: DeviceFingerprint
    public let establishedAt: Int

    public init(sessionId: String, deviceFingerprint: DeviceFingerprint, establishedAt: Int) {
        self.sessionId = sessionId
        self.deviceFingerprint = deviceFingerprint
        self.establishedAt = establishedAt
    }
}
public enum SessionSigning: Sendable {
    public static let domainPrefix = "agentdesk-session"

    public static func canonicalInput(
        clientNonce: Data,
        hostNonce: Data,
        hostFingerprint: String,
        deviceFingerprint: DeviceFingerprint
    ) -> Data {
        var data = Data()
        data.append(Data(domainPrefix.utf8))
        data.append(clientNonce)
        data.append(hostNonce)
        data.append(Data(hostFingerprint.utf8))
        data.append(Data(deviceFingerprint.rawValue.utf8))
        return data
    }
}
