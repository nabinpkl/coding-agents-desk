import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        ClientDiagnostics.shared.bootstrap()
        // At launch, not at the first handover: the gate decides whether the path has held
        // still, which it can only answer if it was already watching. Started when the link
        // moves, it would read its very first snapshot as stable.
        if #available(iOS 26.0, *) {
            SessionPathReadiness.shared.start()
        }
        // Started here so the cadence is running before anything interesting is logged. The
        // drain only sees its own process, so a launch that never starts it leaves the run's
        // Logger output out of the durable store entirely.
        OSLogDrain.shared.start()
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        ClientDiagnostics.shared.bootstrap()
        ClientDiagnostics.shared.record(
            type: "appConfigurationForConnecting",
            fields: ["sessionRole": connectingSceneSession.role.rawValue],
            level: .info
        )
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    func applicationWillTerminate(_ application: UIApplication) {
        ClientDiagnostics.shared.markCleanShutdown(reason: "applicationWillTerminate")
    }
}
