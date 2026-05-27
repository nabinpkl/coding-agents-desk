import Foundation

// Mirror of the host-side resolver. Splits a Space's top-window metadata
// into a two-line label: primary = window title, secondary = app name.
// Truncation thresholds are slightly larger than the host because the
// iOS strip tile renders the caption across two independently truncated
// rows; each row gets its own visual ellipsis at the UILabel layer too,
// the char cap here is just a hard ceiling.
struct ResolvedLabel: Equatable {
    let primary: String
    let secondary: String
}

enum SpaceAgentLabelResolver {
    static let primaryMaxLength: Int = 28
    static let secondaryMaxLength: Int = 28

    // See host-side resolver for the rationale. Editor window titles
    // (VS Code, Cursor, Xcode, JetBrains, Zed) split into
    // "<file>  <workspace>" so we hand-parse: row 1 = file, row 2 =
    // workspace. App name dropped because the dock icon already conveys
    // which editor is running.
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
            // Workspace on top, file below.
            return ResolvedLabel(
                primary: truncate(last, maxLength: primaryMaxLength),
                secondary: truncate(first, maxLength: secondaryMaxLength)
            )
        }
        // Single-segment editor title is just the workspace; row 2
        // empty when there's no file focused.
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
