import Foundation
import Security

enum TLSIdentityError: Error, LocalizedError {
    case missingCertOrKey
    case openSSLFailed(String)
    case importFailed(OSStatus)
    case noIdentityInBundle

    var errorDescription: String? {
        switch self {
        case .missingCertOrKey: return "TLS cert or key missing in Application Support/AgentDesk"
        case .openSSLFailed(let message): return "openssl pkcs12 failed: \(message)"
        case .importFailed(let status): return "SecPKCS12Import failed: \(status)"
        case .noIdentityInBundle: return "PKCS12 bundle contained no SecIdentity"
        }
    }
}

struct TLSIdentityLoader {
    static let identityPassphrase = "agentdesk-local"

    let certURL: URL
    let keyURL: URL
    let identityURL: URL

    func loadIdentity() throws -> SecIdentity {
        try regenerateIdentityIfStale()
        let data = try Data(contentsOf: identityURL)
        var items: CFArray?
        let status = SecPKCS12Import(
            data as CFData,
            [kSecImportExportPassphrase: Self.identityPassphrase] as CFDictionary,
            &items
        )
        guard status == errSecSuccess, let array = items as? [[String: Any]], let first = array.first else {
            throw TLSIdentityError.importFailed(status)
        }
        guard let identity = first[kSecImportItemIdentity as String] else {
            throw TLSIdentityError.noIdentityInBundle
        }
        return (identity as! SecIdentity)
    }

    private func regenerateIdentityIfStale() throws {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: certURL.path),
              fileManager.fileExists(atPath: keyURL.path) else {
            throw TLSIdentityError.missingCertOrKey
        }
        if fileManager.fileExists(atPath: identityURL.path),
           let certMtime = mtime(of: certURL),
           let keyMtime = mtime(of: keyURL),
           let p12Mtime = mtime(of: identityURL),
           p12Mtime >= certMtime, p12Mtime >= keyMtime {
            return
        }
        try? fileManager.removeItem(at: identityURL)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        process.arguments = [
            "pkcs12", "-export",
            "-out", identityURL.path,
            "-in", certURL.path,
            "-inkey", keyURL.path,
            "-passout", "pass:\(Self.identityPassphrase)"
        ]
        let errPipe = Pipe()
        process.standardError = errPipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "openssl failed"
            throw TLSIdentityError.openSSLFailed(message.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func mtime(of url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }
}
