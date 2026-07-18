import AppKit
import Testing

@testable import AgentDeskHost

@MainActor
struct DockEnrichmentSwapInteractionTests {
    @Test func presenterHoldsDockRunsTypedSwapAndOffersConservativeUndo() async {
        let snapshot = Self.snapshot()
        let renderer = RecordingDockRenderer()
        let executor = RecordingDockSwapExecutor()
        let timer = ManualDockUndoTimer()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: snapshot),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: executor,
            undoTimer: timer
        )
        var held: [Bool] = []
        presenter.onInteractionHeldChange = { held.append($0) }

        presenter.setVisible(true)
        await Task.yield()
        presenter.toggleSwap()
        presenter.selectDesktop(Self.selection(id: 100, desktop: "Desktop 2", monitor: "P"))
        presenter.selectDesktop(Self.selection(id: 200, desktop: "Desktop 8", monitor: "S"))
        await Self.yieldUntil { await executor.swapCalls.count == 1 }

        let swapCalls = await executor.swapCalls
        #expect(swapCalls.count == 1)
        #expect(swapCalls.first?.0 == 100)
        #expect(swapCalls.first?.1 == 200)
        #expect(renderer.state.isUndoAvailable)
        #expect(timer.isScheduled)
        #expect(held.contains(true))

        presenter.undo()
        await Self.yieldUntil { await executor.undoCalls.count == 1 }

        #expect(await executor.undoCalls.count == 1)
        #expect(renderer.state == .idle)
        #expect(held.last == false)
    }

    @Test func undoTimerExpiryAndCancellationAreOwnedByPresenter() async {
        let renderer = RecordingDockRenderer()
        let executor = RecordingDockSwapExecutor()
        let timer = ManualDockUndoTimer()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: Self.snapshot()),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: executor,
            undoTimer: timer
        )

        presenter.setVisible(true)
        await Task.yield()
        presenter.toggleSwap()
        presenter.selectDesktop(Self.selection(id: 100, desktop: "Desktop 2", monitor: "P"))
        presenter.selectDesktop(Self.selection(id: 200, desktop: "Desktop 8", monitor: "S"))
        await Self.yieldUntil { renderer.state.isUndoAvailable }

        timer.fire()
        #expect(renderer.state == .idle)

        presenter.toggleSwap()
        presenter.cancelInteraction()
        #expect(renderer.state == .idle)
        #expect(!timer.isScheduled)
    }

    @Test func panelExposesFixedSwapStatusUndoAndEmptyDesktopTargetsToAccessibility() {
        let panel = DockEnrichmentPanel()
        let snapshot = Self.snapshot()
        var toggles = 0
        var selections: [DockDesktopSwapSelection] = []
        var undos = 0
        var cancellations = 0
        panel.onSwapToggle = { toggles += 1 }
        panel.onDesktopSelection = { selections.append($0) }
        panel.onUndo = { undos += 1 }
        panel.onCancel = { cancellations += 1 }

        panel.render(snapshot, swapState: .choosingSource)

        let swap = panel.descendant(identifier: "dock-desktop-swap") as? HoverButton
        let primary = panel.descendant(identifier: "dock-desktop-select-100") as? NSButton
        #expect(swap != nil)
        #expect(panel.descendant(identifier: "dock-desktop-swap-icon") is NSImageView)
        #expect((panel.descendant(identifier: "dock-desktop-swap-label") as? NSTextField)?.stringValue == "Swap")
        #expect(swap?.isBordered == false)
        #expect(swap?.restingColor != .clear)
        #expect((swap as? DockActionButton)?.foregroundColor.isEqual(AppTheme.onAccent) == true)
        #expect(panel.descendant(identifier: "dock-desktop-swap-status") is NSTextField)
        #expect(panel.descendant(identifier: "dock-desktop-swap-status")?.isHidden == false)
        #expect(primary != nil)
        #expect(panel.descendant(identifier: "dock-desktop-select-200") is NSButton)
        swap?.performClick(nil)
        primary?.performClick(nil)
        panel.cancelOperation(nil)
        #expect(toggles == 1)
        #expect(selections.map(\.spaceID) == [100])
        #expect(cancellations == 1)

        let receipt = DockDesktopSwapReceipt(
            sourceSpaceID: 100,
            destinationSpaceID: 200,
            sourceWindowIDs: [],
            destinationWindowIDs: []
        )
        panel.render(
            snapshot,
            swapState: .undoAvailable(.init(
                source: Self.selection(id: 100, desktop: "Desktop 2", monitor: "P"),
                destination: Self.selection(id: 200, desktop: "Desktop 8", monitor: "S"),
                receipt: receipt
            ))
        )
        let undo = panel.descendant(identifier: "dock-desktop-swap-undo") as? NSButton
        #expect(undo != nil)
        #expect(undo?.isHidden == false)
        undo?.performClick(nil)
        #expect(undos == 1)
    }

    @Test func swapControlIsALabeledOpaqueTileWithDistinctActiveState() {
        let panel = DockEnrichmentPanel()
        panel.frame = NSRect(x: 0, y: 0, width: 800, height: 140)
        panel.render(Self.snapshot(), swapState: .idle)
        panel.layoutSubtreeIfNeeded()

        let swap = panel.descendant(identifier: "dock-desktop-swap") as? HoverButton
        let icon = panel.descendant(identifier: "dock-desktop-swap-icon")
        let label = panel.descendant(identifier: "dock-desktop-swap-label") as? NSTextField
        #expect(swap?.title.isEmpty == true)
        #expect(swap?.image == nil)
        #expect(swap?.accessibilityTitle() == "Swap")
        #expect(swap?.accessibilityLabel() == "Swap desktop contents")
        #expect(swap?.frame.size == NSSize(width: 72, height: 64))
        #expect(icon?.frame.size == NSSize(width: 22, height: 22))
        #expect(label?.stringValue == "Swap")
        if let swap, let icon, let label {
            let iconFrame = icon.convert(icon.bounds, to: swap)
            let labelFrame = label.convert(label.bounds, to: swap)
            let contentFrame = iconFrame.union(labelFrame)
            let bottomPadding = contentFrame.minY - swap.bounds.minY
            let topPadding = swap.bounds.maxY - contentFrame.maxY
            #expect(bottomPadding >= 10)
            #expect(topPadding >= 10)
            #expect(abs(topPadding - bottomPadding) <= 1)
        }
        #expect(swap?.cornerRadius == 12)
        #expect(swap?.layer?.borderWidth == 1)
        #expect(swap?.layer?.backgroundColor?.alpha == 1)
        #expect((swap as? DockActionButton)?.foregroundColor.isEqual(AppTheme.accent) == true)

        panel.render(Self.snapshot(), swapState: .choosingSource)

        #expect(swap?.layer?.borderWidth == 2)
        #expect(swap?.restingColor.isEqual(AppTheme.accent) == true)
        #expect((swap as? DockActionButton)?.foregroundColor.isEqual(AppTheme.onAccent) == true)
    }

    @Test func swapAndDesktopCardsShareOneRowAcrossScrollerStyles() {
        for style in [NSScroller.Style.legacy, .overlay] {
            let panel = DockEnrichmentPanel()
            panel.frame = NSRect(x: 0, y: 0, width: 800, height: 140)
            let window = NSWindow(
                contentRect: panel.frame,
                styleMask: .borderless,
                backing: .buffered,
                defer: false
            )
            window.contentView = panel
            panel.render(Self.snapshot(), swapState: .idle)
            let scrollView = panel.firstDescendant(ofType: NSScrollView.self)
            scrollView?.scrollerStyle = style
            scrollView?.tile()
            window.contentView?.layoutSubtreeIfNeeded()

            let swap = panel.descendant(identifier: "dock-desktop-swap")
            let desktop = panel.descendant(identifier: "dock-desktop-100")
            #expect(scrollView != nil)
            #expect(swap != nil)
            #expect(desktop != nil)
            if let swap, let desktop {
                let swapFrame = swap.convert(swap.bounds, to: panel)
                let desktopFrame = desktop.convert(desktop.bounds, to: panel)
                #expect(abs(swapFrame.maxY - desktopFrame.maxY) <= 0.5)
                #expect(abs(swapFrame.midY - desktopFrame.midY) <= 0.5)
            }
        }
    }

    @Test func pointerTapClassifiesPrimaryClickSeparatelyFromMovement() {
        #expect(WorkspaceShellPointerTap.eventKind(for: .mouseMoved) == .movement)
        #expect(WorkspaceShellPointerTap.eventKind(for: .leftMouseDown) == .primaryClick)
        #expect(WorkspaceShellPointerTap.eventKind(for: .keyDown) == .ignored)
        #expect(
            WorkspaceShellPointerTap.eventMask & (CGEventMask(1) << CGEventType.leftMouseDown.rawValue) != 0
        )
    }

    private static func selection(id: UInt64, desktop: String, monitor: String) -> DockDesktopSwapSelection {
        DockDesktopSwapSelection(spaceID: id, desktopLabel: desktop, monitorBadgeLabel: monitor)
    }

    private static func snapshot() -> DockAppSnapshot {
        DockAppSnapshot(desktopGroups: [
            DockDesktopGroupSummary(
                spaceID: 100,
                displayID: "primary",
                desktopOrdinal: 1,
                monitorName: "Primary",
                monitorFrame: CGRect(x: 0, y: 0, width: 1920, height: 1080),
                isActive: true,
                isMainDisplay: true,
                diagnostic: nil,
                apps: [Self.app()],
                label: "Desktop 2"
            ),
            DockDesktopGroupSummary(
                spaceID: 200,
                displayID: "secondary",
                desktopOrdinal: 7,
                monitorName: "Secondary",
                monitorFrame: CGRect(x: 1920, y: 0, width: 1920, height: 1080),
                isActive: false,
                isMainDisplay: false,
                diagnostic: nil,
                apps: [],
                label: "Desktop 8"
            ),
        ])
    }

    private static func app() -> DockAppInstanceSummary {
        DockAppInstanceSummary(
            pid: 1,
            name: "Test",
            bundleIdentifier: nil,
            bundleURL: nil,
            duplicateIndex: nil,
            axErrorCode: nil,
            windows: []
        )
    }

    private static func yieldUntil(
        _ condition: @escaping @MainActor () async -> Bool
    ) async {
        for _ in 0..<100 where !(await condition()) {
            await Task.yield()
        }
    }
}

private struct StaticDockSnapshotReader: DockAppSnapshotReading {
    let snapshotValue: DockAppSnapshot

    init(snapshot: DockAppSnapshot) {
        snapshotValue = snapshot
    }

    func snapshot() -> DockAppSnapshot { snapshotValue }
}

private struct ImmediateDockSnapshotScheduler: DockSnapshotScheduling {
    func async(_ work: @escaping @Sendable () -> Void) { work() }
}

@MainActor
private final class RecordingDockRenderer: DockEnrichmentRendering {
    private(set) var snapshot = DockAppSnapshot(desktopGroups: [])
    private(set) var state: DockDesktopSwapState = .idle

    func render(_ snapshot: DockAppSnapshot, swapState: DockDesktopSwapState) {
        self.snapshot = snapshot
        state = swapState
    }
}

private actor RecordingDockSwapExecutor: DockDesktopSwapExecuting {
    private(set) var swapCalls: [(UInt64, UInt64)] = []
    private(set) var undoCalls: [DockDesktopSwapReceipt] = []

    func swap(sourceSpaceID: UInt64, destinationSpaceID: UInt64) async throws -> DockDesktopSwapReceipt {
        swapCalls.append((sourceSpaceID, destinationSpaceID))
        return DockDesktopSwapReceipt(
            sourceSpaceID: sourceSpaceID,
            destinationSpaceID: destinationSpaceID,
            sourceWindowIDs: [10],
            destinationWindowIDs: [20]
        )
    }

    func undo(_ receipt: DockDesktopSwapReceipt) async throws -> DockDesktopUndoResult {
        undoCalls.append(receipt)
        return DockDesktopUndoResult(
            restoredWindowIDs: receipt.sourceWindowIDs + receipt.destinationWindowIDs,
            skippedWindowIDs: []
        )
    }
}

@MainActor
private final class ManualDockUndoTimer: DockUndoTiming {
    private var action: (() -> Void)?
    var isScheduled: Bool { action != nil }

    func schedule(_ action: @escaping @MainActor () -> Void) {
        self.action = action
    }

    func cancel() {
        action = nil
    }

    func fire() {
        let next = action
        action = nil
        next?()
    }
}

private extension DockDesktopSwapState {
    var isUndoAvailable: Bool {
        if case .undoAvailable = self { return true }
        return false
    }
}

private extension NSView {
    func firstDescendant<T: NSView>(ofType type: T.Type) -> T? {
        if let match = self as? T { return match }
        return subviews.lazy.compactMap { $0.firstDescendant(ofType: type) }.first
    }

    func descendant(identifier: String) -> NSView? {
        if accessibilityIdentifier() == identifier { return self }
        return subviews.lazy.compactMap { $0.descendant(identifier: identifier) }.first
    }
}
