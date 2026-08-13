import Testing
import UIKit

// Pure surface -> visibility mapping for the shared surface control rail.
// No view controller required: this is the testable seam that keeps the UIKit
// wiring (applySurface) trivial.
struct ControlSurfaceVisibilityTests {
    @Test func controlShowsChromeHidesOtherSurfaces() {
        let v = visibility(for: .control)
        #expect(!v.hostContentHidden)
        #expect(!v.controlRailHidden)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(!v.controlChromeHidden)
        #expect(v.keyboardInteractive)
    }

    @Test func agentShowsWebviewHidesChromeAndBrowser() {
        let v = visibility(for: .agent)
        #expect(!v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func browserShowsMirrorHidesChromeAndAgent() {
        let v = visibility(for: .browser)
        #expect(v.agentHidden)
        #expect(!v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func terminalShowsTerminalHidesChromeAndOtherSurfaces() {
        let v = visibility(for: .terminal)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(!v.terminalHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func workspaceShowsWorkspaceHidesChromeAndOtherSurfaces() {
        let v = visibility(for: .workspace)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(!v.workspaceHidden)
        #expect(v.controlChromeHidden)
        #expect(!v.keyboardInteractive)
    }

    @Test func ideShowsIDEAndHidesEveryOtherSurface() {
        let v = visibility(for: .ide)
        #expect(!v.ideHidden)
        #expect(v.workspaceHidden)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
    }

    // Exactly one full-bleed surface (agent, browser, terminal, or files) may be visible at a
    // time; control shows neither. Guards against a future mapping edit that
    // reveals two overlapping surfaces.
    @Test func atMostOneFullBleedSurfaceVisible() {
        for surface in [ControlSurface.control, .agent, .browser, .terminal, .workspace, .ide, .voice] {
            let v = visibility(for: surface)
            let visibleCount = (v.agentHidden ? 0 : 1)
                + (v.browserHidden ? 0 : 1)
                + (v.terminalHidden ? 0 : 1)
                + (v.workspaceHidden ? 0 : 1)
                + (v.ideHidden ? 0 : 1)
                + (v.voiceHidden ? 0 : 1)
            #expect(visibleCount <= 1)
        }
    }

    @Test func voiceShowsProbeAndHidesEveryOtherSurface() {
        let v = visibility(for: .voice)
        #expect(v.hostContentHidden)
        #expect(v.controlRailHidden)
        #expect(!v.voiceHidden)
        #expect(v.ideHidden)
        #expect(v.workspaceHidden)
        #expect(v.agentHidden)
        #expect(v.browserHidden)
        #expect(v.terminalHidden)
        #expect(v.controlChromeHidden)
        // The probe's own text field is a local first responder; the host
        // keyboard helper must stay disabled so keys are not forwarded to the Mac.
        #expect(!v.keyboardInteractive)
    }

    /// The host stops encoding for this client whenever this is `.none`, so a
    /// surface wrongly demanding video costs the whole downlink for pixels its
    /// own webview is covering.
    @Test func onlyControlDemandsTheHostVideo() {
        #expect(ControlSurface.control.videoDemand == .live)
        for surface in [ControlSurface.agent, .terminal, .browser, .workspace, .ide, .voice] {
            #expect(surface.videoDemand == .none)
        }
    }

    @Test func onlyVoiceReplacesTheHostContentRoot() {
        let hostSurfaces: [ControlSurface] = [
            .control, .agent, .browser, .terminal, .workspace, .ide
        ]

        for surface in hostSurfaces {
            #expect(!visibility(for: surface).hostContentHidden)
            #expect(!visibility(for: surface).controlRailHidden)
        }
        #expect(visibility(for: .voice).hostContentHidden)
        #expect(visibility(for: .voice).controlRailHidden)
    }
}

@MainActor
struct VoicePlaygroundNavigationTests {
    @Test func backToVideoControlEmitsExit() throws {
        guard #available(iOS 26.0, *) else { return }
        let surface = VoicePlaygroundSurface()
        let button = try #require(
            surface.control(identifier: "voice-back-to-video") as? UIButton
        )
        var exitCount = 0
        surface.onBackToVideo = {
            exitCount += 1
        }

        #expect(button.configuration?.title == "Back to Video")
        surface.backToVideo()

        #expect(exitCount == 1)
    }
}

@MainActor
struct VoiceSavedAttemptPresentationTests {
    @Test func viewAnalysisTogglesInlineDisclosureState() {
        guard #available(iOS 26.0, *) else { return }
        let analysisContainer = UIView()
        analysisContainer.isHidden = true
        let button = UIButton(type: .system)
        button.setTitle("View analysis", for: .normal)
        button.accessibilityValue = "Collapsed"

        let didReveal = VoicePlaygroundSurface.toggleSavedAttemptAnalysis(
            analysisContainer,
            button: button
        )

        #expect(didReveal)
        #expect(!analysisContainer.isHidden)
        #expect(button.title(for: .normal) == "Hide analysis")
        #expect(button.accessibilityValue == "Expanded")

        let didRevealAgain = VoicePlaygroundSurface.toggleSavedAttemptAnalysis(
            analysisContainer,
            button: button
        )

        #expect(!didRevealAgain)
        #expect(analysisContainer.isHidden)
        #expect(button.title(for: .normal) == "View analysis")
        #expect(button.accessibilityValue == "Collapsed")
    }

    @Test func savedAnalysisTextContainsStoredRecognitionDetails() {
        guard #available(iOS 26.0, *) else { return }
        let withoutContext = VoiceReading(
            top: VoiceRecognitionCandidate(text: "thank", confidence: 0.61),
            alternatives: [
                VoiceRecognitionCandidate(text: "think", confidence: 0.42)
            ]
        )
        let withContext = VoiceReading(
            top: VoiceRecognitionCandidate(text: "think", confidence: 0.88),
            alternatives: []
        )
        let attempt = VoiceSavedAttempt(
            schemaVersion: VoiceSavedAttempt.currentSchemaVersion,
            id: UUID(),
            createdAt: Date(),
            targetPhrase: "think",
            localeIdentifier: "en-US",
            durationSeconds: 1,
            frameCount: 16_000,
            audioFileName: VoiceSavedAttempt.audioFileName,
            analyzerFormat: VoiceAnalyzerFormatMetadata(
                sampleRate: 16_000,
                channelCount: 1,
                commonFormat: "pcmFloat32",
                isInterleaved: false,
                container: "caf",
                codec: "linearPCM"
            ),
            build: VoiceBuildIdentity(
                bundleIdentifier: "voice.tests",
                marketingVersion: "1",
                buildNumber: "1",
                gitSHA: "test"
            ),
            analysis: VoiceAttemptAnalysis(
                withoutContext: withoutContext,
                withContext: withContext,
                withoutContextTargetMatch: .alternative,
                withContextTargetMatch: .topResult,
                verdict: .clear
            ),
            analysisFailure: nil
        )

        let text = VoicePlaygroundSurface.savedAttemptAnalysisText(attempt)

        #expect(text.contains("No context\nthank"))
        #expect(text.contains("alts: think (0.420)"))
        #expect(text.contains("With target as context\nthink"))
        #expect(text.contains("Other recognition candidates\nthank"))
    }
}

// R30: the rail offers icon buttons for every surface, fitting narrow iPhone widths where text
// labels crowd. These pin the pure ordering/availability and per-surface metadata the UIKit
// switcher builds from (and that a11y-driven flows target by label).
struct SurfaceSwitcherTests {
    @Test func withoutBrowserOffersFiveHostSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: false) == [.control, .agent, .terminal, .workspace, .ide])
    }

    @Test func withBrowserOffersSixHostSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: true) == [.control, .agent, .terminal, .browser, .workspace, .ide])
    }

    @Test func voiceIsNotGatedByHostSurfaceAvailability() {
        #expect(!availableControlSurfaces(browserAvailable: false).contains(.voice))
        #expect(!availableControlSurfaces(browserAvailable: true).contains(.voice))
    }

    @Test func everySurfaceHasADistinctSymbolAndStableAccessibilityLabel() {
        let all: [ControlSurface] = [.control, .agent, .terminal, .browser, .workspace, .ide, .voice]
        // Distinct SF Symbols so all segments are visually distinguishable.
        let symbols = all.map(\.switcherSymbolName)
        #expect(Set(symbols).count == all.count)
        symbols.forEach { #expect(!$0.isEmpty) }
        // Labels are the product-facing words the a11y-driven Maestro flows tap.
        #expect(ControlSurface.control.switcherAccessibilityLabel == "Control")
        #expect(ControlSurface.agent.switcherAccessibilityLabel == "Agent")
        #expect(ControlSurface.terminal.switcherAccessibilityLabel == "Terminal")
        #expect(ControlSurface.browser.switcherAccessibilityLabel == "Browser")
        #expect(ControlSurface.workspace.switcherSymbolName == "rectangle.split.3x1")
        #expect(UIImage(systemName: ControlSurface.workspace.switcherSymbolName) != nil)
        #expect(ControlSurface.workspace.switcherAccessibilityLabel == "Workspace")
        #expect(ControlSurface.ide.switcherAccessibilityLabel == "IDE")
        #expect(ControlSurface.voice.switcherAccessibilityLabel == "Voice")
        #expect(UIImage(systemName: ControlSurface.voice.switcherSymbolName) != nil)
    }

    // The switcher resolves a tapped segment back to its surface via the label round-trip, so this
    // inverse must hold for every surface and reject unknown labels (-> safe .control fallback).
    @Test func accessibilityLabelRoundTripsToSurface() {
        for surface in [ControlSurface.control, .agent, .terminal, .browser, .workspace, .ide, .voice] {
            #expect(ControlSurface(switcherAccessibilityLabel: surface.switcherAccessibilityLabel) == surface)
        }
        #expect(ControlSurface(switcherAccessibilityLabel: "Nonexistent") == nil)
    }
}

private extension UIView {
    func control(identifier: String) -> UIControl? {
        if accessibilityIdentifier == identifier { return self as? UIControl }
        return subviews.lazy.compactMap { $0.control(identifier: identifier) }.first
    }
}
