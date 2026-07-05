import Foundation
import Testing

@testable import AgentDeskClient

struct SettingsStoreTests {
    @Test func autoKeyboardEnabledDefaultsTrue() {
        let defaults = isolatedDefaults()
        let store = SettingsStore(defaults: defaults)

        #expect(store.autoKeyboardEnabled)
    }

    @Test func autoKeyboardEnabledPersistsAndPostsChange() async {
        let defaults = isolatedDefaults()
        let store = SettingsStore(defaults: defaults)
        var observed = false
        let observer = NotificationCenter.default.addObserver(
            forName: SettingsStore.changedNotification,
            object: store,
            queue: nil
        ) { _ in
            observed = true
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        store.autoKeyboardEnabled = false

        #expect(store.autoKeyboardEnabled == false)
        #expect(defaults.object(forKey: "agentDesk.autoKeyboardEnabled") as? Bool == false)
        #expect(observed)
    }

    private func isolatedDefaults() -> UserDefaults {
        let name = "SettingsStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
}
