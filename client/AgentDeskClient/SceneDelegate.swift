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
        let window = UIWindow(windowScene: windowScene)
        let pairingVC = PairingViewController()
        window.rootViewController = pairingVC
        window.makeKeyAndVisible()
        self.window = window
        if let url = connectionOptions.urlContexts.first?.url {
            pairingVC.handleIncomingPairingURL(url)
        } else if let url = Self.pairingURLFromLaunchArguments() {
            pairingVC.handleIncomingPairingURL(url)
        }
    }

    // Dev path: `xcrun devicectl device process launch ... com.example.agentdesk.AgentDeskClient <agentdesk URL>`
    // surfaces the URL as a CommandLine argument rather than a URLContext. Route it
    // manually so pairing can be driven from the Mac CLI without the QR camera step.
    private static func pairingURLFromLaunchArguments() -> URL? {
        for arg in CommandLine.arguments.dropFirst() {
            guard arg.hasPrefix("agentdesk://") else { continue }
            if let url = URL(string: arg) {
                return url
            }
        }
        return nil
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url,
              let pairingVC = window?.rootViewController as? PairingViewController else {
            return
        }
        pairingVC.handleIncomingPairingURL(url)
    }
}
