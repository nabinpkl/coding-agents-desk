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

    // Mint a Tailscale-issued cert (Let's Encrypt chain, trusted by iOS) when
    // the cert/key are missing. Idempotent: no-op if both files exist.
    func bootstrapCertViaTailscale(fqdn: String) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: certURL.path), fm.fileExists(atPath: keyURL.path) {
            return
        }
        try fm.createDirectory(at: certURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let tailscale = Self.locateTailscale() else {
            throw TLSIdentityError.openSSLFailed("tailscale binary not found at /usr/local/bin or /Applications/Tailscale.app")
        }
        let trimmedFQDN = fqdn.hasSuffix(".") ? String(fqdn.dropLast()) : fqdn
        let process = Process()
        process.executableURL = tailscale
        process.arguments = [
            "cert",
            "--cert-file", certURL.path,
            "--key-file", keyURL.path,
            trimmedFQDN
        ]
        let errPipe = Pipe()
        process.standardError = errPipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "tailscale cert failed"
            throw TLSIdentityError.openSSLFailed("tailscale cert: \(msg.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    private static func locateTailscale() -> URL? {
        let candidates = [
            "/usr/local/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

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
