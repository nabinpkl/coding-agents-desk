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
        // Locked to dark. The app sits below a screen-share video that's
        // almost always dark Mac content, and a white app canvas in
        // light mode created a jarring middle band against the
        // naturally-dark iOS status bar and home-indicator chrome
        // (status bar text is white over a dark video, home indicator
        // sits in a dark safe-area strip). Forcing .dark keeps the
        // whole frame tonally consistent.
        window.overrideUserInterfaceStyle = .dark
        window.makeKeyAndVisible()
        self.window = window
        if let url = connectionOptions.urlContexts.first?.url {
            pairingVC.handleIncomingPairingURL(url)
        } else if let url = Self.pairingURLFromLaunchArguments() {
            pairingVC.handleIncomingPairingURL(url)
        }
    }

    // Dev path: `xcrun devicectl device process launch --environment-variables`
    // can populate AGENTDESK_LAUNCH_URL with an agentdesk:// URL so the recipe-
    // driven flow can deliver the deeplink without the QR camera step.
    private static func pairingURLFromLaunchArguments() -> URL? {
        if let envURL = ProcessInfo.processInfo.environment["AGENTDESK_LAUNCH_URL"],
           envURL.hasPrefix("agentdesk://"),
           let url = URL(string: envURL) {
            return url
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
