import CryptoKit
import Foundation

struct SessionResumeMaterial: Equatable, Sendable {
    let id: Data
    let secret: Data
    let expiresAt: Int
    let mediaKeySalt: Data
    let clientNonce: Data
    let hostNonce: Data
}

struct SessionHandshakeOutcome: Sendable {
    let active: ActiveSession
    let transport: QuicSessionClientTransport
    let resume: SessionResumeMaterial
    // ADR-0038 DOM mirror: the .dom lane reader, opened only when the client setting is on and the
    // host accepts it. nil when DOM mirroring is off. Decoupled from the media transport.
    let domMirror: DomMirrorClient?
}

struct SessionConnection: Sendable {
    let active: ActiveSession
    let transport: QuicSessionClientTransport
    let inputChannel: InputChannel
    let mediaTransport: MediaTransport
    let resume: SessionResumeMaterial
    let host: String
    let port: UInt16
    let domMirror: DomMirrorClient?
}
