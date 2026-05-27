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
