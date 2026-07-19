import AppKit
import Testing

@testable import AgentDeskHost

@MainActor
struct AgentWindowSplitViewTests {
    @Test func closedStateHasNoNativeTerminalFootprint() {
        let feed = NSView()
        let terminal = NSView()
        let split = AgentWindowSplitView(feedView: feed, terminalView: terminal)
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 720)
        split.layoutSubtreeIfNeeded()

        #expect(split.isTerminalOpen == false)
        #expect(feed.frame == split.bounds)
        #expect(terminal.superview == nil)
        #expect(split.dividerViewForTesting.superview == nil)
        #expect(
            split.dividerViewForTesting.accessibilityIdentifier()
                == AgentWindowAccessibilityIdentifiers.terminalSplitter
        )
        #expect(
            terminal.accessibilityIdentifier()
                == AgentWindowAccessibilityIdentifiers.terminalContent
        )
    }

    @Test func openingUsesDefaultFractionAndShrinksTheFeed() {
        let feed = NSView()
        let terminal = NSView()
        let split = AgentWindowSplitView(feedView: feed, terminalView: terminal)
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 720)
        split.layoutSubtreeIfNeeded()
        let closedFeedHeight = feed.frame.height

        split.setTerminalOpen(true)
        split.layoutSubtreeIfNeeded()

        #expect(split.isTerminalOpen)
        #expect(abs(split.terminalFraction - 0.38) < 0.001)
        #expect(abs(terminal.frame.height / split.bounds.height - 0.38) < 0.01)
        #expect(feed.frame.height < closedFeedHeight)
        #expect(feed.frame.minY >= split.dividerViewForTesting.frame.maxY)
        #expect(split.dividerViewForTesting.frame.minY >= terminal.frame.maxY)
    }

    @Test func resizeClampsToSupportedTerminalFractions() {
        let split = AgentWindowSplitView(feedView: NSView(), terminalView: NSView())
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 720)
        split.setTerminalOpen(true)

        split.setTerminalFraction(0.9)
        split.layoutSubtreeIfNeeded()
        #expect(abs(split.terminalFraction - 0.65) < 0.001)

        split.setTerminalFraction(0.1)
        split.layoutSubtreeIfNeeded()
        #expect(abs(split.terminalFraction - 0.25) < 0.001)
    }

    @Test func accessibilityResizeActionsAdjustTheOpenTerminalFraction() {
        let split = AgentWindowSplitView(feedView: NSView(), terminalView: NSView())
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 720)
        split.setTerminalOpen(true)
        split.layoutSubtreeIfNeeded()

        let starting = split.terminalFraction
        #expect(split.dividerViewForTesting.accessibilityPerformIncrement())
        #expect(abs(split.terminalFraction - (starting + 0.05)) < 0.001)
        #expect(split.dividerViewForTesting.accessibilityPerformDecrement())
        #expect(abs(split.terminalFraction - starting) < 0.001)
    }

    @Test func resizingTheWindowPreservesTheChosenFraction() {
        let terminal = NSView()
        let split = AgentWindowSplitView(feedView: NSView(), terminalView: terminal)
        split.frame = NSRect(x: 0, y: 0, width: 480, height: 720)
        split.setTerminalOpen(true)
        split.setTerminalFraction(0.5)
        split.layoutSubtreeIfNeeded()

        split.frame.size.height = 900
        split.layoutSubtreeIfNeeded()

        #expect(abs(terminal.frame.height / split.bounds.height - 0.5) < 0.01)
    }
}
