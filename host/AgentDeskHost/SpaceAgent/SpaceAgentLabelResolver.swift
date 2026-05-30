import Foundation

// Pure helper that splits a Space's top-window metadata into the two
// strings we paint under each tile:
//   primary   = the window title (e.g. a browser tab name, a file path,
//                a workspace name). If the title is empty we promote
//                the app name into the primary slot.
//   secondary = the running app's name (e.g. "Google Chrome", "Code").
//                Empty when the title was absent and the app name had
//                to fill in as primary, or when no top window exists
//                at all.
// Both strings are returned in full; the renderer truncates each to fit its
// row at draw time, and search matches against the untruncated text.
struct ResolvedLabel: Equatable {
    let primary: String
    let secondary: String
}

enum SpaceAgentLabelResolver {
    // Editors render their window title as "<file>  <workspace>" with an
    // em-dash separator. For these apps the app name on row 2 is wasted
    // (dock icon already says "Code"), so we hand-parse the title:
    //   row 1 = workspace / project (the stable identity of the window)
    //   row 2 = file (transient, what's being edited right now; empty
    //           when no file is focused)
    // Workspace gets the prominent slot because it's how the user
    // identifies which desktop this is; file is the changing detail.
    // Match on appName string; bundle ID would be sturdier but we don't
    // plumb it today. Add new editors here as they show up.
    static let editorAppNames: Set<String> = [
        "Code", "Code - Insiders", "Cursor", "Xcode", "Zed",
        "IntelliJ IDEA", "WebStorm", "PyCharm", "GoLand", "RubyMine",
        "CLion", "AppCode", "PhpStorm", "DataGrip", "Rider",
        "Android Studio"
    ]

    static func resolve(topWindow: SpaceTopWindow?, fallback: String) -> ResolvedLabel {
        guard let topWindow else {
            return ResolvedLabel(primary: fallback, secondary: "")
        }
        let title = topWindow.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let appName = (topWindow.appName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, appName.isEmpty {
            return ResolvedLabel(primary: fallback, secondary: "")
        }
        if title.isEmpty {
            return ResolvedLabel(primary: appName, secondary: "")
        }
        if editorAppNames.contains(appName) {
            return splitEditorTitle(title, appName: appName)
        }
        return ResolvedLabel(primary: title, secondary: appName)
    }

    static func splitEditorTitle(_ title: String, appName: String) -> ResolvedLabel {
        let parts = title.components(separatedBy: " \u{2014} ")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if parts.count >= 2, let first = parts.first, let last = parts.last {
            // Last segment is the workspace, first segment is the file.
            return ResolvedLabel(primary: last, secondary: first)
        }
        // Single-segment editor title means no file is focused; the
        // segment is the workspace. Fall back to the app name on row 2
        // so the two-row caption stays uniform across the strip
        // (Spotify's "category descriptor" move).
        return ResolvedLabel(primary: title, secondary: appName)
    }
}
