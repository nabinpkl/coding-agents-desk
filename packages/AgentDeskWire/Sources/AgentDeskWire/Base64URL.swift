// Base64URL codec (ADR-0050). A dependency of the pairing/session wire types, so
// it lives in the package as the single definition; both apps import it.
import Foundation

public enum Base64URLError: Error {
    case invalidInput
}

extension Data {
    public init(base64URLEncoded string: String) throws {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - base64.count % 4) % 4
        base64.append(String(repeating: "=", count: padding))
        guard let data = Data(base64Encoded: base64) else {
            throw Base64URLError.invalidInput
        }
        self = data
    }

    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
