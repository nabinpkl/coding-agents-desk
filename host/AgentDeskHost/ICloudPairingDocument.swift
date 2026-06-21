import CryptoKit
import Foundation

enum ICloudPairingDocumentError: Error, Equatable {
    case unsupportedSchemaVersion(Int)
    case expired
    case consumed
    case malformedURL
    case hashMismatch
}

struct ICloudPairingDocument: Codable, Equatable {
    let schemaVersion: Int
    let createdAt: Date
    let expiresAt: Date
    let hostName: String
    let pairingURL: URL
    let payloadHash: String
    let consumed: Bool

    init(
        schemaVersion: Int = 1,
        createdAt: Date,
        expiresAt: Date,
        hostName: String,
        pairingURL: URL,
        payloadHash: String,
        consumed: Bool
    ) {
        self.schemaVersion = schemaVersion
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.hostName = hostName
        self.pairingURL = pairingURL
        self.payloadHash = payloadHash
        self.consumed = consumed
    }

    // Integrity check against accidental corruption of the synced document, not
    // an authentication boundary: it is an unkeyed digest, so any writer to the
    // shared container can recompute it. The trust anchor is the signed
    // PairingPayload inside the URL plus host approval, enforced downstream.
    static func payloadHash(for url: URL) -> String {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    func isExpired(at date: Date) -> Bool {
        date >= expiresAt
    }

    func validPairingURL(at date: Date) throws -> URL {
        guard schemaVersion == 1 else {
            throw ICloudPairingDocumentError.unsupportedSchemaVersion(schemaVersion)
        }
        guard !consumed else {
            throw ICloudPairingDocumentError.consumed
        }
        guard !isExpired(at: date) else {
            throw ICloudPairingDocumentError.expired
        }
        guard pairingURL.scheme == "agentdesk",
              pairingURL.host == "pair"
        else {
            throw ICloudPairingDocumentError.malformedURL
        }
        guard payloadHash == Self.payloadHash(for: pairingURL) else {
            throw ICloudPairingDocumentError.hashMismatch
        }
        return pairingURL
    }
}

enum ICloudPairingPublisherError: Error {
    case iCloudUnavailable
}

final class ICloudPairingPublisher {
    private let containerIdentifier: String?
    private let relativePath: String
    private let ttl: TimeInterval
    private let ubiquityContainer: (String?) -> URL?
    private let now: () -> Date
    private let hostName: () -> String
    private let fileManager: FileManager

    init(
        containerIdentifier: String?,
        relativePath: String,
        ttl: TimeInterval,
        ubiquityContainer: @escaping (String?) -> URL? = FileManager.default.url(forUbiquityContainerIdentifier:),
        now: @escaping () -> Date = Date.init,
        hostName: @escaping () -> String = { Host.current().localizedName ?? "Mac" },
        fileManager: FileManager = .default
    ) {
        self.containerIdentifier = containerIdentifier
        self.relativePath = relativePath
        self.ttl = ttl
        self.ubiquityContainer = ubiquityContainer
        self.now = now
        self.hostName = hostName
        self.fileManager = fileManager
    }

    func publish(pairingURL: URL) throws -> ICloudPairingDocument {
        let fileURL = try documentURL()
        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let createdAt = now()
        let document = ICloudPairingDocument(
            createdAt: createdAt,
            expiresAt: createdAt.addingTimeInterval(ttl),
            hostName: hostName(),
            pairingURL: pairingURL,
            payloadHash: ICloudPairingDocument.payloadHash(for: pairingURL),
            consumed: false
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(document).write(to: fileURL, options: .atomic)
        return document
    }

    func clear() throws {
        let fileURL = try documentURL()
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        try fileManager.removeItem(at: fileURL)
    }

    func clearIfMatches(oneTimeNonce: Data) throws {
        let fileURL = try documentURL()
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        // A document that cannot be decoded, or whose URL cannot be parsed back
        // to a payload, is junk that will never pair. Remove it rather than
        // letting a corrupt file outlive the pairing it was meant to carry.
        guard
            let document = try? JSONDecoder().decode(ICloudPairingDocument.self, from: Data(contentsOf: fileURL)),
            let payload = try? PairingPayload.decode(fromPairingURL: document.pairingURL)
        else {
            try fileManager.removeItem(at: fileURL)
            return
        }
        guard payload.oneTimeNonce == oneTimeNonce else { return }
        try fileManager.removeItem(at: fileURL)
    }

    private func documentURL() throws -> URL {
        guard let root = ubiquityContainer(containerIdentifier) else {
            throw ICloudPairingPublisherError.iCloudUnavailable
        }
        return root.appendingPathComponent(relativePath, isDirectory: false)
    }
}
