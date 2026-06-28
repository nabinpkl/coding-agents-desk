import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
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
