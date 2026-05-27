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
// Both strings are independently truncated so the renderer can paint
// each on its own line without one consuming the other's width.
struct ResolvedLabel: Equatable {
    let primary: String
    let secondary: String
}

enum SpaceAgentLabelResolver {
    static let primaryMaxLength: Int = 22
    static let secondaryMaxLength: Int = 22

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
            return ResolvedLabel(
                primary: truncate(appName, maxLength: primaryMaxLength),
                secondary: ""
            )
        }
        if editorAppNames.contains(appName) {
            return splitEditorTitle(title)
        }
        return ResolvedLabel(
            primary: truncate(title, maxLength: primaryMaxLength),
            secondary: truncate(appName, maxLength: secondaryMaxLength)
        )
    }

    static func splitEditorTitle(_ title: String) -> ResolvedLabel {
        let parts = title.components(separatedBy: " \u{2014} ")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if parts.count >= 2, let first = parts.first, let last = parts.last {
            // Last segment is the workspace, first segment is the file.
            return ResolvedLabel(
                primary: truncate(last, maxLength: primaryMaxLength),
                secondary: truncate(first, maxLength: secondaryMaxLength)
            )
        }
        // Single-segment editor title means no file is focused; the
        // segment is the workspace. Leave row 2 empty rather than fake
        // a placeholder; the workspace name on its own reads cleanly.
        return ResolvedLabel(
            primary: truncate(title, maxLength: primaryMaxLength),
            secondary: ""
        )
    }

    static func truncate(_ value: String, maxLength: Int) -> String {
        if value.count <= maxLength { return value }
        return String(value.prefix(maxLength - 1)) + "\u{2026}"
    }
}
