import CryptoKit
import Foundation

struct SessionResumeMaterial: Equatable, Sendable {
    let token: Data
    let expiresAt: Int
    let mediaKeySalt: Data
    let clientNonce: Data
    let hostNonce: Data
}

struct SessionHandshakeOutcome: Sendable {
    let active: ActiveSession
    let transport: QuicSessionClientTransport
    let resume: SessionResumeMaterial
}

struct SessionConnection: Sendable {
    let active: ActiveSession
    let transport: QuicSessionClientTransport
    let inputChannel: InputChannel
    let mediaTransport: MediaTransport
    let resume: SessionResumeMaterial
    let host: String
    let port: UInt16
}
