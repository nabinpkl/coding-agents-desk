import AppKit
import ApplicationServices
import Foundation

/// Event-driven outside Mission Control. Its exit check mirrors the host's topology observer:
/// only the interval between an AX Expose entry notification and exit reads Dock visibility.
final class DesktopSpacesObserver {
    private let changed: () -> Void
    private let failed: () -> Void
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []
    private var axObserver: AXObserver?
    private var dock: AXUIElement?
    private var exitCheck: DispatchWorkItem?
    private var running = false
    private(set) var available = false
    private let notifications = ["AXExposeShowAllWindows", "AXExposeShowFrontWindows", "AXExposeShowDesktop"]

    init(changed: @escaping () -> Void, failed: @escaping () -> Void) {
        self.changed = changed
        self.failed = failed
    }

    func start() {
        guard !running else { return }
        running = true
        let workspace = NSWorkspace.shared.notificationCenter
        tokens.append((workspace, workspace.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.changed() }))
        let center = NotificationCenter.default
        tokens.append((center, center.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.changed() }))
        tokens.append((workspace, workspace.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.bundleIdentifier == "com.apple.dock" { self?.registerDock() }
        }))
        registerDock()
    }

    func stop() {
        running = false
        exitCheck?.cancel()
        exitCheck = nil
        for (center, token) in tokens { center.removeObserver(token) }
        tokens.removeAll()
        unregisterDock()
    }

    private func unregisterDock() {
        available = false
        guard let observer = axObserver else { return }
        if let dock {
            for name in notifications { AXObserverRemoveNotification(observer, dock, name as CFString) }
        }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        axObserver = nil
        dock = nil
    }

    private func registerDock() {
        unregisterDock()
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock")
            .first?.processIdentifier else { failed(); return }
        var observer: AXObserver?
        guard AXObserverCreate(pid, desktopSpacesAXCallback, &observer) == .success,
              let observer else { failed(); return }
        let element = AXUIElementCreateApplication(pid)
        var registered = false
        for name in notifications {
            if AXObserverAddNotification(observer, element, name as CFString,
                Unmanaged.passUnretained(self).toOpaque()) == .success { registered = true }
        }
        guard registered else { failed(); return }
        axObserver = observer
        dock = element
        available = true
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }

    fileprivate func enteredMissionControl() {
        guard running, exitCheck == nil else { return }
        scheduleExitCheck()
    }

    private func scheduleExitCheck() {
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.running else { return }
            self.exitCheck = nil
            guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
                as? [[String: Any]] else { self.failed(); return }
            let visible = windows.contains {
                $0[kCGWindowName as String] == nil
                    && $0[kCGWindowOwnerName as String] as? String == "Dock"
                    && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 18
            }
            if visible { self.scheduleExitCheck() } else { self.changed() }
        }
        exitCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
    }
}

private func desktopSpacesAXCallback(
    _: AXObserver, _: AXUIElement, _: CFString, context: UnsafeMutableRawPointer?
) {
    guard let context else { return }
    let observer = Unmanaged<DesktopSpacesObserver>.fromOpaque(context).takeUnretainedValue()
    DispatchQueue.main.async { [weak observer] in observer?.enteredMissionControl() }
}
