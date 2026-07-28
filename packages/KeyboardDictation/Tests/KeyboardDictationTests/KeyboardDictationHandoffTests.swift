import Foundation
import Testing
@testable import KeyboardDictation

struct KeyboardDictationHandoffTests {
    @Test func handoffURLRoundTripsNonce() {
        let nonce = UUID()

        #expect(KeyboardDictationHandoff.nonce(
            from: KeyboardDictationHandoff.handoffURL(nonce: nonce)
        ) == nonce)
    }

    @Test func unrelatedURLsAreRejected() {
        #expect(KeyboardDictationHandoff.nonce(from: URL(string: "agentdesk://pair")!) == nil)
        #expect(KeyboardDictationHandoff.nonce(
            from: URL(string: "otherapp://keyboard-spike?nonce=invalid")!
        ) == nil)
    }

    @Test func appGroupStorePreservesTheLatestReceipt() throws {
        let suite = "KeyboardDictationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = KeyboardHandoffStore(defaults: defaults)
        let nonce = UUID()
        let receivedAt = Date(timeIntervalSince1970: 1_784_520_000)

        let receipt = try store.record(nonce: nonce, receivedAt: receivedAt)

        #expect(receipt == KeyboardHandoffReceipt(nonce: nonce, receivedAt: receivedAt))
        #expect(try store.latestReceipt() == receipt)

        store.savePendingNonce(nonce)
        #expect(store.pendingNonce() == nonce)
    }

    @Test func invalidStoredReceiptFailsLoudly() throws {
        let suite = "KeyboardDictationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = KeyboardHandoffStore(defaults: defaults)
        defaults.set(Data("not-json".utf8), forKey: "keyboardDictation.handoffReceipt")

        #expect(throws: KeyboardHandoffStoreError.invalidStoredReceipt) {
            try store.latestReceipt()
        }
    }

    @Test func onlyThePendingKeyboardNonceCanBeAcknowledged() throws {
        let suite = "KeyboardDictationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = KeyboardHandoffStore(defaults: defaults)
        let pendingNonce = UUID()
        store.savePendingNonce(pendingNonce)

        #expect(throws: KeyboardHandoffStoreError.unexpectedHandoffNonce) {
            try store.recordPendingHandoff(nonce: UUID())
        }
        #expect(try store.recordPendingHandoff(nonce: pendingNonce).nonce == pendingNonce)
    }
}
