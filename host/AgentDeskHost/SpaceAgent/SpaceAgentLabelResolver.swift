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
        return ResolvedLabel(
            primary: truncate(title, maxLength: primaryMaxLength),
            secondary: truncate(appName, maxLength: secondaryMaxLength)
        )
    }

    static func truncate(_ value: String, maxLength: Int) -> String {
        if value.count <= maxLength { return value }
        return String(value.prefix(maxLength - 1)) + "\u{2026}"
    }
}
