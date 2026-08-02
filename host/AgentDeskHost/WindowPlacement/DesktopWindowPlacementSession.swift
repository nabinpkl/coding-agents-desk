import AppKit
import OSLog

/// AppKit lifecycle adapter around `DesktopWindowPlacementCoordinator`. It obtains a real window
/// number while hidden, restores frame and Space membership, and captures deliberate movement
/// without allowing AppKit's reveal events to rewrite the saved destination.
@MainActor
final class DesktopWindowPlacementSession {
    private let coordinator: DesktopWindowPlacementCoordinator
    private let logger: Logger
    private var placement: WorkspaceWindowPlacement
    private var captureTask: Task<Void, Never>?
    private var isPreparing = false
    private var preservesUnresolvedPlacement = false
    private var isStopped = false

    var onPlacementChanged: ((WorkspaceWindowPlacement) -> Void)?

    init(
        placement: WorkspaceWindowPlacement,
        coordinator: DesktopWindowPlacementCoordinator,
        logger: Logger
    ) {
        self.placement = placement
        self.coordinator = coordinator
        self.logger = logger
    }

    @discardableResult
    func present(_ window: NSWindow, focus: Bool) -> Bool {
        guard !isStopped else { return false }
        isPreparing = true
        let priorAlpha = window.alphaValue
        window.alphaValue = 0
        window.orderBack(nil)
        window.displayIfNeeded()

        if let windowID = windowID(for: window) {
            do {
                placement = try coordinator.restore(
                    placement,
                    windowID: windowID,
                    applyFrame: { window.setFrame($0, display: false) }
                )
                preservesUnresolvedPlacement = false
                onPlacementChanged?(placement)
            } catch {
                preservesUnresolvedPlacement = true
                logger.error("window placement restore failed: \(String(describing: error), privacy: .public)")
            }
        } else {
            preservesUnresolvedPlacement = true
            logger.error("window placement restore skipped: AppKit returned no window number")
        }

        guard !preservesUnresolvedPlacement else {
            window.orderOut(nil)
            window.alphaValue = priorAlpha
            isPreparing = false
            return false
        }
        if focus, Config.axAutomationEnabled {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderFrontRegardless()
        }
        if let windowID = windowID(for: window), !preservesUnresolvedPlacement {
            do {
                try coordinator.verify(windowID: windowID, targetSpaceID: placement.desktop.spaceID)
            } catch {
                preservesUnresolvedPlacement = true
                logger.error("window placement changed during reveal: \(String(describing: error), privacy: .public)")
            }
        }
        if preservesUnresolvedPlacement {
            window.orderOut(nil)
        }
        window.alphaValue = priorAlpha
        isPreparing = false
        return !preservesUnresolvedPlacement
    }

    func windowDidChange(_ window: NSWindow) {
        guard !isPreparing, !isStopped, !preservesUnresolvedPlacement else { return }
        captureTask?.cancel()
        captureTask = Task { @MainActor [weak self, weak window] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self, let window, !self.isStopped,
                  let windowID = self.windowID(for: window) else { return }
            do {
                guard let captured = try self.coordinator.capture(windowID: windowID, frame: window.frame) else {
                    return
                }
                self.placement = captured
                self.onPlacementChanged?(captured)
            } catch {
                self.logger.error("window placement capture failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func stop() {
        isStopped = true
        captureTask?.cancel()
        captureTask = nil
        onPlacementChanged = nil
    }

    private func windowID(for window: NSWindow) -> UInt32? {
        guard window.windowNumber > 0 else { return nil }
        return UInt32(window.windowNumber)
    }
}
