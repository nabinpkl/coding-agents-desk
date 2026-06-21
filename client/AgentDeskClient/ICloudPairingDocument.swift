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

enum ICloudPairingReaderError: Error, Equatable {
    case iCloudUnavailable
    case noPairingFile
    case expired
    case malformed
}

final class ICloudPairingReader {
    private let containerIdentifier: String?
    private let relativePath: String
    private let ubiquityContainer: (String?) -> URL?
    private let now: () -> Date
    private let fileManager: FileManager

    init(
        containerIdentifier: String?,
        relativePath: String,
        ubiquityContainer: @escaping (String?) -> URL? = FileManager.default.url(forUbiquityContainerIdentifier:),
        now: @escaping () -> Date = Date.init,
        fileManager: FileManager = .default
    ) {
        self.containerIdentifier = containerIdentifier
        self.relativePath = relativePath
        self.ubiquityContainer = ubiquityContainer
        self.now = now
        self.fileManager = fileManager
    }

    func readPairingURL() throws -> URL {
        guard let root = ubiquityContainer(containerIdentifier) else {
            throw ICloudPairingReaderError.iCloudUnavailable
        }
        let fileURL = root.appendingPathComponent(relativePath, isDirectory: false)
        guard fileManager.fileExists(atPath: fileURL.path) else {
            throw ICloudPairingReaderError.noPairingFile
        }
        let document: ICloudPairingDocument
        do {
            document = try JSONDecoder().decode(ICloudPairingDocument.self, from: Data(contentsOf: fileURL))
        } catch {
            throw ICloudPairingReaderError.malformed
        }
        do {
            return try document.validPairingURL(at: now())
        } catch ICloudPairingDocumentError.expired {
            throw ICloudPairingReaderError.expired
        } catch {
            throw ICloudPairingReaderError.malformed
        }
    }
}
