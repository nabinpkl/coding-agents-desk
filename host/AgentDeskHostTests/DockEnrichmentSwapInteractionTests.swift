import AppKit
import Testing

@testable import AgentDeskHost

@MainActor
struct DockEnrichmentSwapInteractionTests {
    @Test func presenterHoldsDockRunsTypedSwapAndOffersConservativeUndo() async {
        let snapshot = Self.snapshot()
        let renderer = RecordingDockRenderer()
        let executor = RecordingDockSwapExecutor()
        let focusExecutor = RecordingDockFocusExecutor()
        let timer = ManualDockUndoTimer()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: snapshot),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: executor,
            focusExecutor: focusExecutor,
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
        let focusExecutor = RecordingDockFocusExecutor()
        let timer = ManualDockUndoTimer()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: Self.snapshot()),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: executor,
            focusExecutor: focusExecutor,
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

    @Test func oneWindowIconPrimaryActionDispatchesItsDesktopScopedTarget() {
        let panel = DockEnrichmentPanel()
        panel.frame = NSRect(x: 0, y: 0, width: 800, height: 140)
        let snapshot = Self.focusSnapshot(windowCount: 1)
        var requests: [DockWindowFocusRequest] = []
        panel.onWindowFocus = { requests.append($0) }
        panel.render(snapshot, swapState: .idle)
        panel.layoutSubtreeIfNeeded()

        let appButton = panel.descendant(identifier: "dock-app-44")

        #expect(appButton?.acceptsFirstMouse(for: nil) == true)
        if let appButton, let superview = appButton.superview {
            let iconCenter = appButton.convert(
                NSPoint(x: appButton.bounds.midX, y: appButton.bounds.midY),
                to: superview
            )
            #expect(appButton.hitTest(iconCenter) === appButton)
        }
        #expect(appButton?.accessibilityPerformPress() == true)
        #expect(requests.count == 1)
        #expect(requests.first?.pid == 44)
        #expect(requests.first?.windowID == 700)
        #expect(requests.first?.targetSpaceID == 100)
        #expect(requests.first?.targetDisplayID == "primary")
    }

    @Test func desktopTileRoutesBlankHitAreasToDesktopActivationWithoutCapturingAppIcons() {
        let panel = DockEnrichmentPanel()
        panel.frame = NSRect(x: 0, y: 0, width: 800, height: 140)
        let snapshot = Self.focusSnapshot(windowCount: 1)
        var desktopRequests: [DockDesktopActivationRequest] = []
        var windowRequests: [DockWindowFocusRequest] = []
        panel.onDesktopActivation = { desktopRequests.append($0) }
        panel.onWindowFocus = { windowRequests.append($0) }
        panel.render(snapshot, swapState: .idle)
        panel.layoutSubtreeIfNeeded()

        let desktop = panel.descendant(identifier: "dock-desktop-100")
        let appIcon = panel.descendant(identifier: "dock-app-44")
        #expect(desktop?.acceptsFirstMouse(for: nil) == true)
        if let desktop {
            let blankTilePoint = desktop.convert(NSPoint(x: 100, y: 8), to: panel)
            #expect(panel.hitTest(blankTilePoint) === desktop)
        }
        #expect(desktop?.accessibilityPerformPress() == true)
        #expect(desktopRequests == [
            DockDesktopActivationRequest(spaceID: 100, displayID: "primary", desktopLabel: "Desktop 1"),
        ])
        #expect(windowRequests.isEmpty)

        #expect(appIcon?.accessibilityPerformPress() == true)
        #expect(desktopRequests.count == 1)
        #expect(windowRequests.map(\.windowID) == [700])
    }

    @Test func presenterActivatesDesktopWithoutFocusingAWindow() async {
        let renderer = RecordingDockRenderer()
        let focusExecutor = RecordingDockFocusExecutor()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: Self.focusSnapshot(windowCount: 1)),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: RecordingDockSwapExecutor(),
            focusExecutor: focusExecutor,
            undoTimer: ManualDockUndoTimer()
        )
        let group = Self.focusSnapshot(windowCount: 1).desktopGroups[0]
        let request = try! #require(DockDesktopActivationRequest(group: group))

        presenter.activateDesktop(request)
        await Self.yieldUntil { focusExecutor.desktopRequests == [request] }

        #expect(focusExecutor.requests.isEmpty)
        presenter.stop()
    }

    @Test func multipleDesktopScopedWindowsRequireChooserInsteadOfDirectFocus() {
        let group = Self.focusSnapshot(windowCount: 2).desktopGroups[0]

        #expect(DockWindowFocusRequest.onlyWindow(in: group.apps, group: group) == nil)
    }

    @Test func directFocusDoesNotAggregateMatchingAppsFromOtherDesktopCards() {
        let firstGroup = Self.focusSnapshot(windowCount: 1).desktopGroups[0]
        let secondApp = DockAppInstanceSummary(
            pid: 45,
            name: "Editor",
            bundleIdentifier: "dev.test.editor",
            bundleURL: nil,
            duplicateIndex: 2,
            axErrorCode: nil,
            windows: [
                DockAppWindowSummary(
                    windowID: 701,
                    title: "Other Desktop Window",
                    role: "AXWindow",
                    subrole: "AXStandardWindow",
                    isFocused: false,
                    isMinimized: false,
                    isOnScreen: true,
                    layer: 0,
                    alpha: 1,
                    bounds: CGRect(x: 20, y: 20, width: 300, height: 200),
                    spaceIDs: [200]
                ),
            ]
        )
        let secondGroup = DockDesktopGroupSummary(
            spaceID: 200,
            displayID: "primary",
            missionControlOrdinal: 1,
            monitorName: "Primary",
            monitorFrame: nil,
            isActive: false,
            isMainDisplay: true,
            diagnostic: nil,
            apps: [secondApp]
        )
        let panel = DockEnrichmentPanel()
        var requests: [DockWindowFocusRequest] = []
        panel.onWindowFocus = { requests.append($0) }
        panel.render(
            DockAppSnapshot(desktopGroups: [firstGroup, secondGroup]),
            swapState: .idle
        )

        #expect(panel.descendant(identifier: "dock-app-44")?.accessibilityPerformPress() == true)
        #expect(requests.map(\.windowID) == [700])
        #expect(requests.map(\.targetSpaceID) == [100])
    }

    @Test func popoverWindowButtonPreservesExactFocusIdentityAndAccessibility() {
        let group = Self.focusSnapshot(windowCount: 1).desktopGroups[0]
        let request = DockWindowFocusRequest(
            app: group.apps[0],
            window: group.apps[0].windows[0],
            group: group
        )
        var received: DockWindowFocusRequest?
        let button = DockWindowFocusButton(request: request) { received = $0 }

        #expect(button.accessibilityIdentifier() == "dock-window-focus-44-700")
        #expect(button.accessibilityLabel() == "Focus Window 1")
        #expect(button.acceptsFirstMouse(for: nil))
        #expect(button.accessibilityPerformPress())
        #expect(received == request)
    }

    @Test func newerWindowFocusCancelsThePreviousPresenterRequest() async {
        let renderer = RecordingDockRenderer()
        let focusExecutor = CancellableDockFocusExecutor()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: Self.focusSnapshot(windowCount: 1)),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: RecordingDockSwapExecutor(),
            focusExecutor: focusExecutor,
            undoTimer: ManualDockUndoTimer()
        )
        let group = Self.focusSnapshot(windowCount: 1).desktopGroups[0]
        let first = DockWindowFocusRequest(
            app: group.apps[0],
            window: group.apps[0].windows[0],
            group: group
        )
        let second = DockWindowFocusRequest(
            app: group.apps[0],
            window: DockAppWindowSummary(
                windowID: 701,
                title: "Window 2",
                role: "AXWindow",
                subrole: "AXStandardWindow",
                isFocused: false,
                isMinimized: false,
                isOnScreen: true,
                layer: 0,
                alpha: 1,
                bounds: CGRect(x: 20, y: 20, width: 300, height: 200),
                spaceIDs: [100]
            ),
            group: group
        )

        presenter.focusWindow(first)
        await Task.yield()
        presenter.focusWindow(second)
        await Self.yieldUntil { focusExecutor.cancelledWindowIDs.contains(700) }

        #expect(focusExecutor.requestedWindowIDs == [700, 701])
        #expect(focusExecutor.cancelledWindowIDs.contains(700))
        presenter.stop()
    }

    @Test func presenterSurfacesWindowFocusFailureWithoutReportingSuccess() async {
        let renderer = RecordingDockRenderer()
        let focusExecutor = FailingDockFocusExecutor()
        let presenter = DockEnrichmentPresenter(
            reader: StaticDockSnapshotReader(snapshot: Self.focusSnapshot(windowCount: 1)),
            renderer: renderer,
            snapshotScheduler: ImmediateDockSnapshotScheduler(),
            swapExecutor: RecordingDockSwapExecutor(),
            focusExecutor: focusExecutor,
            undoTimer: ManualDockUndoTimer()
        )
        let group = Self.focusSnapshot(windowCount: 1).desktopGroups[0]
        let request = DockWindowFocusRequest(
            app: group.apps[0],
            window: group.apps[0].windows[0],
            group: group
        )

        presenter.focusWindow(request)
        await Self.yieldUntil { renderer.windowFocusFailure != nil }

        #expect(
            renderer.windowFocusFailure ==
                DockWindowFocusError.accessibilityPermissionRequired.localizedDescription
        )
        presenter.stop()
    }

    private static func selection(id: UInt64, desktop: String, monitor: String) -> DockDesktopSwapSelection {
        DockDesktopSwapSelection(spaceID: id, desktopLabel: desktop, monitorBadgeLabel: monitor)
    }

    private static func snapshot() -> DockAppSnapshot {
        DockAppSnapshot(desktopGroups: [
            DockDesktopGroupSummary(
                spaceID: 100,
                displayID: "primary",
                missionControlOrdinal: 1,
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
                missionControlOrdinal: 7,
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

    private static func focusSnapshot(windowCount: Int) -> DockAppSnapshot {
        var windows: [DockAppWindowSummary] = []
        for offset in 0..<windowCount {
            let windowID = UInt32(700 + offset)
            let title = "Window \(offset + 1)"
            let x = CGFloat(10 + offset * 20)
            let window = DockAppWindowSummary(
                windowID: windowID,
                title: title,
                role: "AXWindow",
                subrole: "AXStandardWindow",
                isFocused: offset == 0,
                isMinimized: false,
                isOnScreen: true,
                layer: 0,
                alpha: 1,
                bounds: CGRect(x: x, y: 10, width: 300, height: 200),
                spaceIDs: [100]
            )
            windows.append(window)
        }
        let app = DockAppInstanceSummary(
            pid: 44,
            name: "Editor",
            bundleIdentifier: "dev.test.editor",
            bundleURL: nil,
            duplicateIndex: nil,
            axErrorCode: nil,
            windows: windows
        )
        return DockAppSnapshot(desktopGroups: [
            DockDesktopGroupSummary(
                spaceID: 100,
                displayID: "primary",
                missionControlOrdinal: 0,
                monitorName: "Primary",
                monitorFrame: nil,
                isActive: true,
                isMainDisplay: true,
                diagnostic: nil,
                apps: [app]
            ),
        ])
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
    private(set) var windowFocusFailure: String?

    func render(_ snapshot: DockAppSnapshot, swapState: DockDesktopSwapState) {
        self.snapshot = snapshot
        state = swapState
    }

    func renderWindowFocusFailure(_ message: String?) {
        windowFocusFailure = message
    }
}

@MainActor
private final class RecordingDockFocusExecutor: DockWindowFocusExecuting {
    private(set) var requests: [DockWindowFocusRequest] = []
    private(set) var desktopRequests: [DockDesktopActivationRequest] = []

    func focus(_ request: DockWindowFocusRequest) async throws {
        requests.append(request)
    }

    func activateDesktop(_ request: DockDesktopActivationRequest) async throws {
        desktopRequests.append(request)
    }
}

@MainActor
private final class CancellableDockFocusExecutor: DockWindowFocusExecuting {
    private(set) var requestedWindowIDs: [UInt32] = []
    private(set) var cancelledWindowIDs: [UInt32] = []

    func focus(_ request: DockWindowFocusRequest) async throws {
        let windowID = request.windowID ?? 0
        requestedWindowIDs.append(windowID)
        do {
            try await Task.sleep(for: .seconds(60))
        } catch {
            cancelledWindowIDs.append(windowID)
            throw error
        }
    }

    func activateDesktop(_ request: DockDesktopActivationRequest) async throws {}
}

@MainActor
private final class FailingDockFocusExecutor: DockWindowFocusExecuting {
    func focus(_ request: DockWindowFocusRequest) async throws {
        throw DockWindowFocusError.accessibilityPermissionRequired
    }

    func activateDesktop(_ request: DockDesktopActivationRequest) async throws {
        throw DockDesktopActivationError.spaceSwitchRejected(request.spaceID)
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
