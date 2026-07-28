import Foundation

/// The deliberately small contract shared by the containing app and the
/// development-only keyboard spike. It proves a keyboard-originated handoff
/// and return through an App Group; it does not represent a recording session.
public enum KeyboardDictationHandoff {
    public static let appGroupInfoKey = "AgentDeskKeyboardAppGroup"
    public static let handoffURLScheme = "agentdesk"
    public static let handoffURLHost = "keyboard-spike"
    public static let handoffNonceQueryItem = "nonce"

    public static func appGroupIdentifier(in bundle: Bundle = .main) throws -> String {
        guard let identifier = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
              !identifier.isEmpty
        else {
            throw KeyboardHandoffStoreError.missingAppGroupIdentifier
        }
        return identifier
    }

    public static func handoffURL(nonce: UUID) -> URL {
        var components = URLComponents()
        components.scheme = handoffURLScheme
        components.host = handoffURLHost
        components.queryItems = [
            URLQueryItem(name: handoffNonceQueryItem, value: nonce.uuidString)
        ]
        guard let url = components.url else {
            preconditionFailure("Keyboard handoff URL must be representable")
        }
        return url
    }

    public static func nonce(from url: URL) -> UUID? {
        guard url.scheme?.lowercased() == handoffURLScheme,
              url.host?.lowercased() == handoffURLHost,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let rawNonce = components.queryItems?.first(where: {
                  $0.name == handoffNonceQueryItem
              })?.value
        else {
            return nil
        }
        return UUID(uuidString: rawNonce)
    }
}

public enum KeyboardHandoffStoreError: Error, Equatable, LocalizedError {
    case missingAppGroupIdentifier
    case unavailableAppGroup(String)
    case invalidStoredReceipt
    case unexpectedHandoffNonce

    public var errorDescription: String? {
        switch self {
        case .missingAppGroupIdentifier:
            "The keyboard App Group is not configured."
        case .unavailableAppGroup:
            "The keyboard App Group is unavailable."
        case .invalidStoredReceipt:
            "The saved keyboard handoff state is invalid."
        case .unexpectedHandoffNonce:
            "This keyboard handoff did not match the pending request."
        }
    }
}

public struct KeyboardHandoffReceipt: Codable, Equatable, Sendable {
    public let nonce: UUID
    public let receivedAt: Date

    public init(nonce: UUID, receivedAt: Date) {
        self.nonce = nonce
        self.receivedAt = receivedAt
    }
}

public struct KeyboardHandoffStore {
    private static let receiptKey = "keyboardDictation.handoffReceipt"
    private static let pendingNonceKey = "keyboardDictation.pendingNonce"

    private let defaults: UserDefaults

    public init(appGroupIdentifier: String) throws {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
            throw KeyboardHandoffStoreError.unavailableAppGroup(appGroupIdentifier)
        }
        self.defaults = defaults
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public func savePendingNonce(_ nonce: UUID) {
        defaults.set(nonce.uuidString, forKey: Self.pendingNonceKey)
    }

    public func pendingNonce() -> UUID? {
        defaults.string(forKey: Self.pendingNonceKey).flatMap(UUID.init(uuidString:))
    }

    @discardableResult
    public func record(nonce: UUID, receivedAt: Date = Date()) throws -> KeyboardHandoffReceipt {
        let receipt = KeyboardHandoffReceipt(nonce: nonce, receivedAt: receivedAt)
        let data = try JSONEncoder().encode(receipt)
        defaults.set(data, forKey: Self.receiptKey)
        return receipt
    }

    /// A containing app must only acknowledge a URL that was first requested
    /// by this keyboard instance through the shared App Group.
    @discardableResult
    public func recordPendingHandoff(
        nonce: UUID,
        receivedAt: Date = Date()
    ) throws -> KeyboardHandoffReceipt {
        guard pendingNonce() == nonce else {
            throw KeyboardHandoffStoreError.unexpectedHandoffNonce
        }
        return try record(nonce: nonce, receivedAt: receivedAt)
    }

    public func latestReceipt() throws -> KeyboardHandoffReceipt? {
        guard let data = defaults.data(forKey: Self.receiptKey) else {
            return nil
        }
        do {
            return try JSONDecoder().decode(KeyboardHandoffReceipt.self, from: data)
        } catch {
            throw KeyboardHandoffStoreError.invalidStoredReceipt
        }
    }
}
