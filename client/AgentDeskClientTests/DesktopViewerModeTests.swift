import Testing

struct DesktopViewerModeTests {
    @Test func nativeDesktopOwnsVideoChromeAndKeyboard() {
        let presentation = DesktopViewerPresentation.resolve(surface: .control, mode: .native)

        #expect(!presentation.tabsHidden)
        #expect(!presentation.nativeChromeHidden)
        #expect(presentation.webViewHidden)
        #expect(presentation.keyboardInteractive)
        #expect(presentation.videoDemand == .live)
    }

    @Test func webDesktopPausesNativeVideoAndOwnsTheContentArea() {
        let presentation = DesktopViewerPresentation.resolve(surface: .control, mode: .web)

        #expect(!presentation.tabsHidden)
        #expect(presentation.nativeChromeHidden)
        #expect(!presentation.webViewHidden)
        #expect(!presentation.keyboardInteractive)
        #expect(presentation.videoDemand == .none)
    }

    @Test func anotherSurfaceHidesBothDesktopImplementations() {
        for surface in ControlSurface.allCases where surface != .control {
            for mode in [DesktopViewerMode.native, .web] {
                let presentation = DesktopViewerPresentation.resolve(surface: surface, mode: mode)
                #expect(presentation.tabsHidden)
                #expect(presentation.nativeChromeHidden)
                #expect(presentation.webViewHidden)
                #expect(!presentation.keyboardInteractive)
                #expect(presentation.videoDemand == .none)
            }
        }
    }
}
