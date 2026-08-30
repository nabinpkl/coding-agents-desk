enum DesktopViewerMode: Int, Equatable {
    case native
    case web
}

/// Combines the selected top-level surface with the Desktop surface's own viewer tab.
///
/// These are two independent axes: the right rail chooses Desktop, Agent, Terminal, and the other
/// first-party surfaces; the top bar chooses which implementation owns Desktop itself. Keeping the
/// composition pure gives the native encoder pause, chrome, keyboard, tabs, and WebView one answer.
struct DesktopViewerPresentation: Equatable {
    let tabsHidden: Bool
    let nativeChromeHidden: Bool
    let webViewHidden: Bool
    let keyboardInteractive: Bool
    let videoDemand: VideoDemand

    static func resolve(surface: ControlSurface, mode: DesktopViewerMode) -> Self {
        let desktopActive = surface == .control
        let nativeActive = desktopActive && mode == .native
        return Self(
            tabsHidden: !desktopActive,
            nativeChromeHidden: !nativeActive,
            webViewHidden: !desktopActive || mode != .web,
            keyboardInteractive: nativeActive,
            videoDemand: nativeActive ? .live : .none
        )
    }
}
