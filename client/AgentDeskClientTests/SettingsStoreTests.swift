import Foundation
import Testing
import AgentDeskWire

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

    @Test func diagnosticScreenshotsRequireExplicitOptIn() {
        let defaults = isolatedDefaults()
        let store = SettingsStore(defaults: defaults)

        #expect(store.diagnosticScreenshotsEnabled == false)
        store.diagnosticScreenshotsEnabled = true
        #expect(store.diagnosticScreenshotsEnabled)
        #expect(defaults.object(forKey: "agentDesk.diagnosticScreenshotsEnabled") as? Bool == true)
    }

    @Test func fixedConstrainedMediaProfileIsRepresentableAndAtomic() {
        let defaults = isolatedDefaults()
        let store = SettingsStore(defaults: defaults)

        store.manualMediaBitrateKbps = 180
        store.manualMediaFps = 1
        store.manualMediaResolutionScale = 0.5
        store.adaptiveMediaQualityEnabled = false

        #expect(SettingsStore.manualMediaBitrateKbpsRange.lowerBound == 180)
        #expect(SettingsStore.manualMediaFpsValues.contains(1))
        #expect(store.mediaQualityConfig == ClientMediaQualityConfig(
            adaptiveEnabled: false,
            fixedTarget: ClientMediaQualityTarget(
                bitrateKbps: 180,
                fps: 1,
                resolutionScale: 0.5
            )
        ))
    }

    @Test func launchFixedMediaProfileOverrideIsExplicitAndNonadaptive() {
        #expect(Config.fixedMediaQualityOverride(environment: [:]) == nil)
        #expect(Config.fixedMediaQualityOverride(environment: [
            "AGENTDESK_CLIENT_FIXED_MEDIA_PROFILE": "180,1,0.5"
        ]) == ClientMediaQualityConfig(
            adaptiveEnabled: false,
            fixedTarget: ClientMediaQualityTarget(
                bitrateKbps: 180,
                fps: 1,
                resolutionScale: 0.5
            )
        ))
    }

    private func isolatedDefaults() -> UserDefaults {
        let name = "SettingsStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
}
