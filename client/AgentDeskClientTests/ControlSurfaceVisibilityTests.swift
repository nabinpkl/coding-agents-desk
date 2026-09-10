import Testing
import UIKit

// Pure surface -> visibility mapping for the shared surface control rail.
// No view controller required: this is the testable seam that keeps the UIKit
// wiring (applySurface) trivial.
struct ControlSurfaceVisibilityTests {
    // Exactly one surface owns the content area -- never two overlapping, never
    // none. This used to be six near-identical per-surface tests plus an
    // "at most one visible" count, which was the strongest claim the old
    // ten-boolean struct could support: it could represent zero visible too.
    // Over `allCases`, so a surface added without a visibility answer fails here
    // rather than shipping invisible.
    @Test func exactlyOneSurfaceOwnsTheContentArea() {
        for surface in ControlSurface.allCases {
            let v = visibility(for: surface)
            let shown = ControlSurface.allCases.filter { !v.isHidden($0) }
            #expect(shown == [surface])
        }
    }

    // The per-view accessors are hand-written one-liners over `isHidden`, so the
    // mistake they can still make is naming the wrong case. Each one is checked
    // against the surface it is named for. Control has no full-bleed view of its
    // own; its surface is the Mac chrome, covered below.
    @Test func eachNamedAccessorFollowsItsOwnSurface() {
        #expect(!visibility(for: .agent).agentHidden)
        #expect(!visibility(for: .browser).browserHidden)
        #expect(!visibility(for: .terminal).terminalHidden)
        #expect(!visibility(for: .workspace).workspaceHidden)
        #expect(!visibility(for: .voice).voiceHidden)
    }

    @Test func onlyVoiceReplacesTheHostContentRoot() {
        for surface in ControlSurface.allCases where surface != .voice {
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
    @Test func withoutBrowserOffersFourHostSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: false) == [.control, .agent, .terminal, .workspace])
    }

    @Test func withBrowserOffersFiveHostSurfacesInOrder() {
        #expect(availableControlSurfaces(browserAvailable: true) == [.control, .agent, .terminal, .browser, .workspace])
    }

    @Test func voiceIsNotGatedByHostSurfaceAvailability() {
        #expect(!availableControlSurfaces(browserAvailable: false).contains(.voice))
        #expect(!availableControlSurfaces(browserAvailable: true).contains(.voice))
    }

    @Test func everySurfaceHasADistinctSymbolAndStableAccessibilityLabel() {
        let all = ControlSurface.allCases
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
        #expect(ControlSurface.voice.switcherAccessibilityLabel == "Voice")
        #expect(UIImage(systemName: ControlSurface.voice.switcherSymbolName) != nil)
    }

    // The switcher resolves a tapped segment back to its surface via the label round-trip, so this
    // inverse must hold for every surface and reject unknown labels (-> safe .control fallback).
    @Test func accessibilityLabelRoundTripsToSurface() {
        for surface in ControlSurface.allCases {
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
