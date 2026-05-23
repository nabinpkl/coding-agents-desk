import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else {
            return
        }
        Self.persistDevHostOverrideIfPresent()
        let window = UIWindow(windowScene: windowScene)
        let pairingVC = PairingViewController()
        window.rootViewController = pairingVC
        window.overrideUserInterfaceStyle = SettingsStore.shared.appearance.interfaceStyle
        window.makeKeyAndVisible()
        self.window = window
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applyAppearance),
            name: SettingsStore.changedNotification,
            object: nil
        )
        if let url = connectionOptions.urlContexts.first?.url {
            pairingVC.handleIncomingPairingURL(url)
        } else if let url = Self.pairingURLFromLaunchArguments() {
            pairingVC.handleIncomingPairingURL(url)
        }
    }

    @objc private func applyAppearance() {
        window?.overrideUserInterfaceStyle = SettingsStore.shared.appearance.interfaceStyle
    }

    // Dev path: `xcrun devicectl device process launch --environment-variables`
    // can populate AGENTDESK_LAUNCH_URL with an agentdesk:// URL so the recipe-
    // driven flow can deliver the deeplink without the QR camera step. We also
    // scan CommandLine.arguments as a fallback though iOS apps launched via
    // LaunchServices typically don't receive argv.
    private static func pairingURLFromLaunchArguments() -> URL? {
        if let envURL = ProcessInfo.processInfo.environment["AGENTDESK_LAUNCH_URL"],
           envURL.hasPrefix("agentdesk://"),
           let url = URL(string: envURL) {
            return url
        }
        for arg in CommandLine.arguments.dropFirst() {
            guard arg.hasPrefix("agentdesk://") else { continue }
            if let url = URL(string: arg) {
                return url
            }
        }
        return nil
    }

    // Simulator-only: capture AGENTDESK_DEV_HOST_OVERRIDE from the launch
    // environment into UserDefaults so subsequent relaunches (e.g. a
    // Maestro flow's launchApp that does not forward env vars) still
    // use the loopback dial host. Without this the first launch via
    // pair-sim works but the auto-reconnect on the next launch falls
    // back to the Tailnet FQDN and parks the app in "Paired
    // (reconnecting)". Gated by targetEnvironment so device builds
    // cannot persist or honour the override.
    private static func persistDevHostOverrideIfPresent() {
        #if targetEnvironment(simulator)
        if let env = ProcessInfo.processInfo.environment["AGENTDESK_DEV_HOST_OVERRIDE"], !env.isEmpty {
            UserDefaults.standard.set(env, forKey: "agentDesk.dev.hostOverride")
        }
        #endif
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url,
              let pairingVC = window?.rootViewController as? PairingViewController else {
            return
        }
        pairingVC.handleIncomingPairingURL(url)
    }
}
