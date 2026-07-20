import Foundation

enum BrowserProjectionResources {
    static let directoryName = "BrowserProjectionWebview"

    static var rootURL: URL? {
        indexURL?.deletingLastPathComponent()
    }

    static var indexURL: URL? {
        Bundle.module.url(
            forResource: "index",
            withExtension: "html",
            subdirectory: directoryName
        )
    }
}
