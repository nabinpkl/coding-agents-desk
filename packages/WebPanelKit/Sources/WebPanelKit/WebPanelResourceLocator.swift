import Foundation

/// Resolves the webview's resource root inside a panel's own bundle: prefer the
/// built bundle directory when it actually contains the index (a real build),
/// else fall back to the committed fixture so a clean checkout still loads.
///
/// The bundle and directory names are panel-supplied — the panel owns its
/// resources, so it passes its `.module` bundle and its own dir names.
public struct WebPanelResourceLocator {
    public let bundle: Bundle
    public let webviewDirectoryName: String
    public let fixtureDirectoryName: String
    public let indexPath: String

    public init(
        bundle: Bundle,
        webviewDirectoryName: String,
        fixtureDirectoryName: String,
        indexPath: String = "index.html"
    ) {
        self.bundle = bundle
        self.webviewDirectoryName = webviewDirectoryName
        self.fixtureDirectoryName = fixtureDirectoryName
        self.indexPath = indexPath
    }

    public func rootDirectory() -> URL? {
        rootDirectory(indexPath: indexPath)
    }

    public func rootDirectory(indexPath: String) -> URL? {
        if let buildOutput = directory(named: webviewDirectoryName),
           FileManager.default.fileExists(
               atPath: buildOutput.appendingPathComponent(indexPath).path
           ) {
            return buildOutput
        }
        return directory(named: fixtureDirectoryName)
    }

    public func indexURL() -> URL? {
        rootDirectory()?.appendingPathComponent(indexPath)
    }

    private func directory(named name: String) -> URL? {
        bundle.url(forResource: name, withExtension: nil)
    }
}
