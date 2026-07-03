// Fingerprint wire types (ADR-0050). Moved verbatim from the former per-app
// SharedTypes.swift; single source of truth for host and client.

import Foundation

public struct DeviceFingerprint: Codable, Hashable, Equatable, CustomStringConvertible, Sendable {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public var description: String { rawValue }
}
